import pino from "pino";
import { loadConfig } from "./config.js";
import { createIngressServer } from "./server.js";
import { createRevocation } from "./revocation.js";

/* The edge's entrypoint. Loads config, refuses to start without a verifying key, and serves.
 *
 * There is no database to connect to and no migration to apply, which is why this file is short: the process
 * holds live connections and nothing else, so "started" and "ready" are the same moment.
 */

const config = loadConfig();
const logger = pino(
    config.log.pretty
        ? { level: config.log.level, transport: { target: `pino-pretty`, options: { colorize: true } } }
        : { level: config.log.level },
);

/* NO KEY, NO EDGE. An ingress that cannot verify grants has exactly two possible behaviors and both are worse
 * than not starting: refuse every sandbox (an outage that looks like a routing bug) or accept every one (an
 * open relay into anybody's workspace). Stopping here is visible in the first line of the container's log. */
if (config.ingress.publicKey === ``) {
    logger.fatal(`INGRESS_PUBLIC_KEY is unset: the edge cannot verify reachability grants and will not start`);
    process.exit(1);
}

const revocation = createRevocation({
    platformUrl: config.platform.url,
    log: (message, error) => logger.warn({ err: error }, message),
});

const ingress = createIngressServer({
    publicKey: config.ingress.publicKey,
    revocation,
    log: (event, message) => logger.info(event, message),
});

await ingress.listen(config.ingress.port, config.ingress.host);
logger.info(
    {
        port: config.ingress.port,
        host: config.ingress.host,
        // Whether revocation is being enforced at all is the one config fact worth stating at boot: a
        // deployment that meant to check and is not would otherwise look identical to one that meant not to.
        revocation: config.platform.url === `` ? `off (no PLATFORM_URL)` : config.platform.url,
    },
    `intentic ingress listening`,
);

const stop = (signal: string): void => {
    logger.info({ signal }, `shutting down`);
    void ingress.close().then(() => process.exit(0));
};
process.on(`SIGTERM`, () => stop(`SIGTERM`));
process.on(`SIGINT`, () => stop(`SIGINT`));
