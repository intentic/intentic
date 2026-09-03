import { randomBytes } from "node:crypto";
import type { Server } from "node:http";
import pino from "pino";
import { createInternalServer, startCluster } from "./cluster.js";
import { loadConfig } from "./config.js";
import { createStaticPeers, parsePeerList, startFlyPeers, type Peer, type PeerDiscovery } from "./peers.js";
import { createTunnelRegistry } from "./registry.js";
import { createRevocation } from "./revocation.js";
import { createIngressServer } from "./server.js";

/* The edge's entrypoint. Loads config, refuses to start without a verifying key, and serves.
 *
 * There is no database to connect to and no migration to apply, which is why this file is short: the process
 * holds live connections and nothing else, so "started" and "ready" are the same moment.
 *
 * WHAT IS WIRED HERE AND NOWHERE ELSE is the cluster: who the peers are (Fly's DNS, a static list, or nobody),
 * how this machine names itself to them, and the private listener the holds protocol rides. Every one of those
 * is a deployment fact, which is why the modules take them as arguments and this file is the one that reads
 * the environment. */

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

// ── The cluster ─────────────────────────────────────────────────────────────────────────────────────────

// This machine's name: what the operator said, else Fly's machine id, else something for this process's life.
const instanceId = config.ingress.instanceId || config.fly.machineId || randomBytes(6).toString(`hex`);
const ports = { port: config.ingress.port, internalPort: config.ingress.internalPort };
// How the peers reach this machine: on Fly its private address, otherwise what the operator advertised.
const self: Peer = { host: config.ingress.advertiseHost || config.fly.privateIp, ...ports };

/* Who the peers are. A static list wins when given, since it is an explicit statement; Fly's internal DNS is
 * used when the app name is present and nothing was stated; and with neither this is one machine, which is the
 * edge as it was before it could have peers. */
const peers: PeerDiscovery =
    config.ingress.peers !== `` || config.fly.appName === ``
        ? createStaticPeers(parsePeerList(config.ingress.peers, ports))
        : startFlyPeers({
              appName: config.fly.appName,
              selfAddress: config.fly.privateIp,
              ...ports,
              log: (message, error) => logger.warn({ err: error }, message),
          });
if (config.ingress.peers !== `` && self.host === ``) {
    logger.warn(`INGRESS_PEERS is set but INGRESS_ADVERTISE_HOST is not: this machine will forward to its peers but cannot tell them what it holds`);
}

const registry = createTunnelRegistry({ onChange: (event) => cluster.onRegistryChange(event) });
const cluster = startCluster({ instanceId, self, peers, registry, log: (event, message) => logger.info(event, message) });

const listen = (server: Server, port: number, host: string): Promise<void> =>
    new Promise<void>((resolve, reject) => {
        server.once(`error`, reject);
        server.listen(port, host, () => {
            server.removeListener(`error`, reject);
            resolve();
        });
    });

// The holds protocol's listener, on the private address when there is one: Fly's 6PN is unreachable from the
// internet by construction, and a compose deployment simply never publishes this port.
const internalHost = config.ingress.internalHost || config.fly.privateIp || `0.0.0.0`;
const internal = createInternalServer({ cluster, registry, self, instanceId });
await listen(internal, config.ingress.internalPort, internalHost);

// ── The edge ────────────────────────────────────────────────────────────────────────────────────────────

const ingress = createIngressServer({
    publicKey: config.ingress.publicKey,
    revocation,
    registry,
    cluster,
    peers,
    instanceId,
    log: (event, message) => logger.info(event, message),
});

await ingress.listen(config.ingress.port, config.ingress.host);
logger.info(
    {
        port: config.ingress.port,
        host: config.ingress.host,
        instance: instanceId,
        // Whether revocation is being enforced at all is the one config fact worth stating at boot: a
        // deployment that meant to check and is not would otherwise look identical to one that meant not to.
        revocation: config.platform.url === `` ? `off (no PLATFORM_URL)` : config.platform.url,
        // And the same for the cluster: one machine, a list, or an app whose DNS is being watched.
        cluster: config.ingress.peers !== `` ? `${peers.current().length} static peers` : config.fly.appName === `` ? `single machine` : `fly app ${config.fly.appName}`,
        internal: `${internalHost}:${config.ingress.internalPort}`,
        advertise: self.host === `` ? `(none)` : self.host,
    },
    `intentic ingress listening`,
);

const stop = (signal: string): void => {
    logger.info({ signal }, `shutting down`);
    cluster.close();
    peers.close();
    internal.close();
    void ingress.close().then(() => process.exit(0));
};
process.on(`SIGTERM`, () => stop(`SIGTERM`));
process.on(`SIGINT`, () => stop(`SIGINT`));
