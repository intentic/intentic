import { readFileSync } from "node:fs";
import { createApp } from "./app.js";
import { CONFIG_SECRETS, loadConfig } from "./config.js";
import { mask } from "./log.js";
import { createLogger } from "./logger.js";
import { createPrisma } from "./prisma.js";
import { startRetention } from "./retention.js";
import { startSandboxPool } from "./sandbox/sandbox-pool.js";
import { startTracing } from "./tracing.js";

// Standard OTEL_* vars come from the environment. The dev/start scripts pass `--env-file=../../.env` so the
// root .env populates process.env under Bun (it only auto-loads .env from cwd); in prod they're real env vars.
const tracing = startTracing();

// Bun is the API runtime: it executes this TypeScript (and the source-first workspace libs) directly — no
// build step in dev. `bun --watch` restarts on change. Bun.serve is the native server; it takes Hono's
// fetch handler as-is and terminates TLS itself in dev (prod runs plain http behind a TLS proxy).
const config = loadConfig();
const logger = createLogger(config);
logger.info({ config: mask(config, CONFIG_SECRETS) }, `config loaded`);
if (!config.google.clientId || !config.google.clientSecret) {
    logger.warn(`GOOGLE_CLIENT_ID/GOOGLE_CLIENT_SECRET unset — Google sign-in will fail until they are provided`);
}
if (!config.secrets.key) {
    logger.warn(`SECRETS_KEY unset — OAuth/sandbox tokens will be persisted in plaintext (never run production like this)`);
}
if (!config.email.apiKey || !config.email.from) {
    logger.warn(`EMAIL_API_KEY/EMAIL_FROM unset — sandbox invite links will be logged instead of emailed`);
}

const prisma = createPrisma(config);
startRetention(prisma, config, logger);
startSandboxPool(prisma, config, logger);
const { app } = createApp(config, prisma, logger);

// Dev serves https (the SPA does too, for FedCM); prod runs plain http behind a TLS-terminating proxy.
const tls =
    config.api.httpsKey && config.api.httpsCert ? { key: readFileSync(config.api.httpsKey), cert: readFileSync(config.api.httpsCert) } : undefined;

const server = Bun.serve({
    port: config.api.port,
    hostname: config.api.host,
    fetch: app.fetch,
    ...(tls && { tls }),
});

// Bound to the loopback IP but advertised as localhost: that is the name the dev cert covers, the origin the
// SPA calls, and the one Better Auth/CORS trust. Printing the IP invites a click that lands on an untrusted
// origin, which the API then rejects with a bare preflight 204 the browser reports as an opaque CORS error.
logger.info({ url: `${tls ? `https` : `http`}://localhost:${server.port}` }, `api started (auth at /api/auth, oRPC at /rpc)`);

const shutdown = async () => {
    logger.info(`shutting down`);
    await prisma.$disconnect();
    await server.stop();
    await tracing?.shutdown();
    process.exit(0);
};

process.on(`SIGTERM`, () => void shutdown());
process.on(`SIGINT`, () => void shutdown());
