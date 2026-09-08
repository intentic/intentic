import { spawn } from "node:child_process";
import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import type { IntenticLine } from "@intentic/sandbox-contract";
import { halt as haltClient, livePid as livePidOf, logTail, toolMissing } from "../tunnel/net-probe.js";
import { rankCountries, VPNGATE_FALLBACK } from "./exit-countries.js";
import type { ExitDriver, ExitProbe } from "./exit-driver.js";
import { observeThroughAddress } from "./exit-observe.js";
import { catalogPath, exitDir, exitInterface, exitProxyPort, exitStateDir, logPath, ovpnPath, pidPath } from "./exit-paths.js";
import { readSelection, writeSelection } from "./exit-state.js";
import { dropProxy, ensureProxy, proxyBound, tunnelAddress, tunnelResolver } from "./exit-tunnel.js";

// VPN Gate, University of Tsukuba's volunteer pool: the only free VPN with a machine-readable server list and no
// account, letting this provider auto-fill completely.
// Mostly Japan and Korea, not a world map; it exists because Tor's Asian exit capacity is thin and 'free, no signup,
// Japanese IP' has no other answer.
// Relays are run by anonymous volunteers who can log anything unencrypted, which is why an exit never carries the
// sandbox's own traffic.

const CATALOG_URL = "https://www.vpngate.net/api/iphone/";
// Short since the pool churns and a stale entry dials slowly; long enough not to hammer repeat browsing.
const CATALOG_TTL_MS = 30 * 60 * 1000;
const DIAL_TIMEOUT_MS = 90_000;

interface VpngateServer {
    readonly host: string;
    readonly ip: string;
    readonly country: string;
    readonly score: number;
    readonly config: string;
}

// Parsed positionally since the header format hasn't changed in a decade; a row under 15 fields is a truncated
// transfer, dropped rather than half-read.
export const parseVpngateCsv = (csv: string): VpngateServer[] =>
    csv
        .split("\n")
        .map((line) => line.trim())
        .filter((line) => line !== "" && !line.startsWith("#") && !line.startsWith("*"))
        .flatMap((line) => {
            const fields = line.split(",");
            if (fields.length < 15) {
                return [];
            }
            const [host, ip, score, , , , country] = fields;
            const config = fields[14];
            if (host === undefined || ip === undefined || country === undefined || config === undefined || config === "") {
                return [];
            }
            return [{ host, ip, country: country.toUpperCase(), score: Number.parseInt(score ?? "0", 10) || 0, config }];
        });

const fetchServers = async (): Promise<VpngateServer[] | undefined> => {
    const response = await fetch(CATALOG_URL, { signal: AbortSignal.timeout(30_000) }).catch(() => undefined);
    if (response === undefined || !response.ok) {
        return undefined;
    }
    const servers = parseVpngateCsv(await response.text().catch(() => ""));
    return servers.length === 0 ? undefined : servers;
};

const cachedServers = async (): Promise<{ servers: VpngateServer[]; live: boolean }> => {
    const path = catalogPath("vpngate");
    const cached = await readFile(path, "utf8")
        .then((raw) => JSON.parse(raw) as { at: number; servers: VpngateServer[] })
        .catch(() => undefined);
    if (cached !== undefined && Date.now() - cached.at < CATALOG_TTL_MS) {
        return { servers: cached.servers, live: true };
    }
    const fresh = await fetchServers();
    if (fresh === undefined) {
        return cached === undefined ? { servers: [], live: false } : { servers: cached.servers, live: false };
    }
    await mkdir(exitDir(), { recursive: true, mode: 0o700 }).catch(() => undefined);
    await writeFile(path, JSON.stringify({ at: Date.now(), servers: fresh }), { mode: 0o600 }).catch(() => undefined);
    return { servers: fresh, live: true };
};

// Highest score in the country, skipping one to avoid: on a pool this small, a new address is just a different server,
// which is what makes `rotate` mean anything. VPN Gate's own score already folds in speed, uptime and load.
const pick = (servers: readonly VpngateServer[], country: string | undefined, avoid: string | undefined): VpngateServer | undefined => {
    const eligible = servers
        .filter((server) => country === undefined || server.country === country.toUpperCase())
        .toSorted((left, right) => right.score - left.score);
    return eligible.find((server) => server.host !== avoid) ?? eligible[0];
};

// `route-nopull` is load-bearing: without it OpenVPN installs the pushed route into the main table, and the sandbox
// loses its uplink. dev/daemon/log lines are dropped, not overridden: their precedence isn't reliable.
const ovpnFor = (id: string, server: VpngateServer): string => {
    const decoded = Buffer.from(server.config, "base64").toString("utf8");
    const stripped = decoded
        .split("\n")
        .filter((line) => !/^\s*(dev|dev-type|daemon|log|log-append|writepid|route-nopull|redirect-gateway|block-outside-dns)\b/.test(line))
        .join("\n");
    return [
        stripped.trimEnd(),
        "",
        "# --- added by intentic: keep this tunnel off the main routing table ---",
        // Ignores every pushed route and DNS; the exit is only reached through its proxy.
        "route-nopull",
        "dev-type tun",
        `dev ${exitInterface(id)}`,
        "daemon",
        `writepid ${pidPath(id)}`,
        `log ${logPath(id)}`,
        // SoftEther servers present small RSA keys/old TLS that OpenSSL 3 refuses by default; lowered here only.
        "tls-cipher DEFAULT:@SECLEVEL=0",
        "data-ciphers AES-128-CBC:AES-256-GCM:AES-128-GCM",
        "verb 3",
        "",
    ].join("\n");
};

// This driver's pidfile/process-name pair, bound to the shared liveness check.
const livePid = (id: string): Promise<number | undefined> => livePidOf(pidPath(id), "openvpn");

// OpenVPN backgrounds itself once the tunnel is up, so the foreground exit code is the dial's verdict. Output goes to
// the log file, not a pipe, so the backgrounded grandchild keeps writing after this promise settles.
const dial = async (id: string): Promise<number> => {
    const handle = await open(logPath(id), "w", 0o600);
    try {
        return await new Promise<number>((resolve, reject) => {
            const child = spawn("openvpn", ["--config", ovpnPath(id)], { stdio: ["ignore", handle.fd, handle.fd] });
            const timer = setTimeout(() => child.kill("SIGTERM"), DIAL_TIMEOUT_MS);
            child.on("error", reject);
            child.on("exit", (code, signal) => {
                clearTimeout(timer);
                resolve(signal !== null ? 124 : (code ?? 1));
            });
        });
    } finally {
        await handle.close();
    }
};

const halt = (id: string): Promise<void> => haltClient(pidPath(id), "openvpn");

// Brings one server up: tear down what was there, write its config, dial, publish the proxy; shared by start and
// rotate, since moving to a server is the same operation either way.
async function* dialServer(id: string, server: VpngateServer): AsyncGenerator<IntenticLine> {
    await halt(id);
    await dropProxy(id);
    await mkdir(exitStateDir(id), { recursive: true, mode: 0o700 });
    await writeFile(ovpnPath(id), ovpnFor(id, server), { mode: 0o600 });
    yield { kind: "log", message: `Dialling ${server.host} (${server.country}) at ${server.ip}…` };
    const code = await dial(id);
    if (code !== 0) {
        throw new Error(`openvpn could not reach ${server.host} (exit ${code}).\n${await logTail(logPath(id))}`);
    }
    const address = await ensureProxy(id);
    await writeSelection(id, { country: server.country, server: server.host });
    yield { kind: "log", message: `Tunnel up on ${exitInterface(id)} (${address}). SOCKS proxy on 127.0.0.1:${exitProxyPort(id)}.` };
}

export const vpngateDriver: ExitDriver = {
    catalog: async () => {
        const { servers, live } = await cachedServers();
        if (servers.length === 0) {
            return { countries: VPNGATE_FALLBACK, live: false };
        }
        const counts = new Map<string, number>();
        for (const server of servers) {
            counts.set(server.country, (counts.get(server.country) ?? 0) + 1);
        }
        return { countries: rankCountries(counts), live };
    },
    write: async (id) => {
        await mkdir(exitStateDir(id), { recursive: true, mode: 0o700 });
    },
    erase: async (id) => {
        await rm(exitStateDir(id), { recursive: true, force: true });
    },
    missingTool: async () => ((await toolMissing("openvpn", ["--version"])) ? "openvpn" : undefined),
    async *start(id, config, country): AsyncGenerator<IntenticLine> {
        const wanted = country ?? config.country;
        yield { kind: "log", message: "Fetching VPN Gate's server list…" };
        const { servers, live } = await cachedServers();
        if (!live && servers.length === 0) {
            throw new Error("VPN Gate's server list could not be fetched and nothing is cached, so there is no server to dial.");
        }
        const server = pick(servers, wanted, undefined);
        if (server === undefined) {
            const available = [...new Set(servers.map((entry) => entry.country))].toSorted().join(", ");
            throw new Error(
                `VPN Gate has no server in ${wanted} right now. It has: ${available}. Its pool is mostly Japan and Korea; for anywhere else use a tor exit.`,
            );
        }
        yield* dialServer(id, server);
    },
    async *rotate(id, config): AsyncGenerator<IntenticLine> {
        const previous = await readSelection(id);
        const { servers } = await cachedServers();
        const country = previous?.country ?? config.country;
        const server = pick(servers, country, previous?.server);
        if (server === undefined) {
            throw new Error(`VPN Gate has no other server in ${country ?? "this pool"} to move to.`);
        }
        if (server.host === previous?.server) {
            throw new Error(
                `VPN Gate has only one server in ${country ?? "this pool"}, so there is no other address to rotate to. Pick another country, or use a tor exit.`,
            );
        }
        yield* dialServer(id, server);
    },
    stop: async (id) => {
        await halt(id);
        await dropProxy(id);
    },
    probe: async (id): Promise<ExitProbe> => {
        const name = exitInterface(id);
        if ((await livePid(id)) === undefined) {
            if (await toolMissing("openvpn", ["--version"])) {
                return { state: "unavailable" };
            }
            const log = await logTail(logPath(id), 3);
            return log === "" ? { state: "down" } : { state: "failed", detail: log.split("\n").at(-1) };
        }
        if ((await tunnelAddress(id)) === undefined) {
            return { state: "starting", interface: name };
        }
        // Client up and addressed but no proxy bound means a restart happened under a live tunnel; reported as starting
        // until the boot restore's ensureProxy closes the gap.
        return proxyBound(id) ? { state: "up", interface: name } : { state: "starting", interface: name, detail: "re-publishing the proxy" };
    },
    observe: async (id) => {
        const address = await tunnelAddress(id);
        if (address === undefined) {
            throw new Error(`${id} has no tunnel address, so there is nothing to check.`);
        }
        return await observeThroughAddress(address, tunnelResolver(address));
    },
};
