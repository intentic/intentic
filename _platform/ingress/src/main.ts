import { randomBytes } from "node:crypto";
import type { Server } from "node:http";
import pino from "pino";
import { createInternalServer, startCluster } from "./cluster.js";
import { loadConfig } from "./config.js";
import { createStaticPeers, parsePeerList, startFlyPeers, type Peer, type PeerDiscovery } from "./peers.js";
import { createTunnelRegistry } from "./registry.js";
import { createRevocation } from "./revocation.js";
import { createIngressServer } from "./server.js";

// Entrypoint: loads config, refuses to start without a verifying key, then serves.
// No database or migration; the process just holds live connections, so started and ready are the same moment.
// Wires the cluster's deployment facts (peers, this machine's name, the private listener) here, and only here.

const config = loadConfig();
const logger = pino(
    config.log.pretty
        ? { level: config.log.level, transport: { target: `pino-pretty`, options: { colorize: true } } }
        : { level: config.log.level },
);

// No key, no edge: unverified grants mean refusing everyone or accepting everyone, worse than not starting.
if (config.ingress.publicKey === ``) {
    logger.fatal(`INGRESS_PUBLIC_KEY is unset: the edge cannot verify reachability grants and will not start`);
    process.exit(1);
}

const revocation = createRevocation({
    platformUrl: config.platform.url,
    log: (message, error) => logger.warn({ err: error }, message),
});

// The cluster.

// This machine's name: operator-set, else Fly's machine id, else random for this process's life.
const instanceId = config.ingress.instanceId || config.fly.machineId || randomBytes(6).toString(`hex`);
const ports = { port: config.ingress.port, internalPort: config.ingress.internalPort };
// How peers reach this machine: Fly's private address, or whatever the operator advertised.
const self: Peer = { host: config.ingress.advertiseHost || config.fly.privateIp, ...ports };

// A static list wins when given; otherwise Fly's DNS is used if there's an app name; else this is one machine.
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

// Private-network listener; Fly's 6PN is unreachable from the internet, and compose never publishes this port.
const internalHost = config.ingress.internalHost || config.fly.privateIp || `0.0.0.0`;
const internal = createInternalServer({ cluster, registry, self, instanceId });
await listen(internal, config.ingress.internalPort, internalHost);

// The edge.

const ingress = createIngressServer({
    publicKey: config.ingress.publicKey,
    revocation,
    registry,
    cluster,
    peers,
    instanceId,
    ...(config.hosted.appPrefix === `` ? {} : { hostedAppPrefix: config.hosted.appPrefix }),
    build: config.ingress.build,
    log: (event, message) => logger.info(event, message),
});

await ingress.listen(config.ingress.port, config.ingress.host);
logger.info(
    {
        port: config.ingress.port,
        host: config.ingress.host,
        instance: instanceId,
        // Which build this is, so the first log line of a machine answers "did the deploy land" on its own.
        build: config.ingress.build === `` ? `(unreleased build)` : config.ingress.build,
        // Whether revocation is enforced, stated plainly so a misconfigured check doesn't look off on purpose.
        revocation: config.platform.url === `` ? `off (no PLATFORM_URL)` : config.platform.url,
        // Whether this machine sees one machine, a static list, or a watched Fly app.
        cluster: config.ingress.peers !== `` ? `${peers.current().length} static peers` : config.fly.appName === `` ? `single machine` : `fly app ${config.fly.appName}`,
        // Whether hosted sandboxes are replayed to their apps.
        replay: config.hosted.appPrefix === `` ? `off (no HOSTED_APP_PREFIX)` : `apps ${config.hosted.appPrefix}-<id>`,
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
