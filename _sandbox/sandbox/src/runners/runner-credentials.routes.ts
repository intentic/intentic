import { type AgentProvider, AgentProviderSchema, DEFAULT_PROVIDER } from "@intentic/sandbox-contract/schemas/agent";
import {
    type RunnerCredential,
    RunnerCredentialRefreshRequestSchema,
    RunnerCredentialRequestSchema,
    runnerTranslatorPath,
} from "@intentic/sandbox-contract/protocol/doors/runner-protocol";
import type { Context } from "hono";
import { replaceRejectedToken } from "../agent/providers/claude/claude-credentials.js";
import type { Services } from "../composition.js";
import type { HarnessCredentialsResult } from "../agent/providers/harness-credentials.js";
import { bearerPeer } from "../peers/peer-store.js";
import { defineRawRoutes } from "../http/raw-route-server.js";
import { resolveHarnessCredentials } from "../agent/providers/harness-credentials.js";
import { forwardToTranslator, toRunnerCredential } from "../sandboxes/credential-lending.js";

// The rules for what leaves this sandbox live beside the link doors that lend the same way (sandboxes/credential-lending.ts).
export { toRunnerCredential } from "../sandboxes/credential-lending.js";

// A runner's turns spend this sandbox's model providers through three bearer-authenticated routes:
// POST /system/runners/credentials: resolves one turn's credential, stripped to what may travel.
// POST /system/runners/credentials/refresh: re-mints a rejected access token against the local store.
// ALL /system/runners/translator/*: proxies the loopback translator so its local bearer never leaves.
// Never travels: refresh tokens, the translator's local bearer, or the per-model allowance (reads parent-local state).

// How this sandbox resolves one turn's credential, the way its own turns do; the app hands in the engine's.
export type CredentialResolver = (input: {
    readonly agent: AgentProvider | undefined;
    readonly account?: string;
    readonly model?: string;
}) => Promise<HarnessCredentialsResult>;

const createRunnerCredentialsRoute =
    (services: Pick<Services, "runners" | "logger" | "config">, resolve: CredentialResolver) =>
    async (c: Context): Promise<Response> => {
        const runner = await bearerPeer(services.runners, c);
        if (typeof runner !== "string") {
            return runner;
        }
        const body = RunnerCredentialRequestSchema.safeParse(await c.req.json().catch(() => undefined));
        if (!body.success) {
            return c.json({ error: "invalid request" }, 400);
        }
        // An unrecognised provider id means the runner's build is newer; refuse readably instead of letting zod throw.
        const agent = body.data.agent === undefined ? undefined : AgentProviderSchema.safeParse(body.data.agent);
        if (agent !== undefined && !agent.success) {
            return c.json({ ok: false, message: `this sandbox does not know the provider "${body.data.agent}" — update it.` } satisfies RunnerCredential);
        }
        const resolved = await resolve({
            agent: agent?.data,
            ...(body.data.account !== undefined ? { account: body.data.account } : {}),
            ...(body.data.model !== undefined ? { model: body.data.model } : {}),
        });
        services.logger.info({ runner, agent: body.data.agent ?? DEFAULT_PROVIDER, ok: resolved.ok }, "runner: credential resolved for a remote turn");
        return c.json(toRunnerCredential(resolved, services.config.translator.url, services.config.claudeCodeOauthToken));
    };

const createRunnerCredentialRefreshRoute =
    (services: Pick<Services, "runners" | "logger" | "claudeStore">) =>
    async (c: Context): Promise<Response> => {
        const runner = await bearerPeer(services.runners, c);
        if (typeof runner !== "string") {
            return runner;
        }
        const body = RunnerCredentialRefreshRequestSchema.safeParse(await c.req.json().catch(() => undefined));
        if (!body.success) {
            return c.json({ error: "invalid request" }, 400);
        }
        const accessToken = await replaceRejectedToken(services.claudeStore, body.data.account, body.data.rejected).catch((error: unknown) => {
            services.logger.warn({ err: error, runner, account: body.data.account }, "runner: mid-turn token re-mint failed");
            return undefined;
        });
        return c.json(accessToken !== undefined ? { accessToken } : {});
    };

export const createRunnerTranslatorProxyRoute =
    (services: Pick<Services, "runners" | "config">) =>
    async (c: Context): Promise<Response> => {
        const runner = await bearerPeer(services.runners, c);
        if (typeof runner !== "string") {
            return runner;
        }
        return await forwardToTranslator(c.req.raw, c.req.path.slice(runnerTranslatorPath.length), services.config.translator);
    };

// The credential doors: per-turn access tokens, mid-turn re-mints, translator behind the runner's own bearer.
export const runnerCredentialRawRoutes = defineRawRoutes((services: Services) => ({
    "POST /system/runners/credentials": createRunnerCredentialsRoute(services, (input) => resolveHarnessCredentials(services, input)),
    "POST /system/runners/credentials/refresh": createRunnerCredentialRefreshRoute(services),
    "ALL /system/runners/translator/*": createRunnerTranslatorProxyRoute(services),
}));
