import { execFile, spawn } from "node:child_process";
import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { promisify } from "node:util";
import type { IntenticLine } from "@intentic/sandbox-contract";
import { logTail, processAlive, readPid, toolMissing } from "../vpn/net-probe.js";
import { rankCountries, VPNGATE_FALLBACK } from "./exit-countries.js";
import type { ExitDriver, ExitProbe } from "./exit-driver.js";
import { observeThroughAddress } from "./exit-observe.js";
import { catalogPath, exitDir, exitInterface, exitProxyPort, exitStateDir, logPath, ovpnPath, pidPath } from "./exit-paths.js";
import { readSelection, writeSelection } from "./exit-state.js";
import { dropProxy, ensureProxy, proxyBound, tunnelAddress, tunnelResolver } from "./exit-tunnel.js";

/* VPN GATE, the University of Tsukuba's volunteer relay pool, and the only free VPN with a machine-readable
 * server list and no account of any kind. Its public CSV IS the catalog: hostname, country, load and a
 * base64'd OpenVPN config per server, which is what lets this provider auto-fill completely, a user picks a
 * country and never sees a hostname.
 *
 * BE HONEST ABOUT ITS SHAPE. Measured against that CSV: ~95 servers across 10 countries, of which Japan and
 * Korea are 87%, and the list barely rotates between polls. It is not a world map. It is here because it
 * covers the half of the world Tor covers worst, Tor's Asian exit capacity is close to nothing, and because
 * "free, no signup, Japanese IP" is a real need with no other free answer.
 *
 * AND ABOUT ITS TRUST MODEL. The relays are run by anonymous volunteers who can log and inspect anything not
 * end-to-end encrypted, and the project keeps connection logs by policy. This is precisely why an exit never
 * carries the sandbox's own traffic: the operator sees what was deliberately pointed at them and nothing else.
 */

const exec = promisify(execFile);

const CATALOG_URL = "https://www.vpngate.net/api/iphone/";
// Short: the pool churns and a stale entry is a dial that fails slowly. Long enough that browsing the country
// list a few times in a row does not hammer a volunteer-funded service.
const CATALOG_TTL_MS = 30 * 60 * 1000;
const DIAL_TIMEOUT_MS = 90_000;

interface VpngateServer {
    readonly host: string;
    readonly ip: string;
    readonly country: string;
    readonly score: number;
    readonly config: string;
}

/* The CSV: a `*vpn_servers` banner, a `#`-prefixed header, rows, and a `*` terminator. Parsed positionally
 * because the header names are stable and the format has not changed in a decade; a row with fewer than 15
 * fields is a truncated transfer, not a server, and is dropped rather than half-read. */
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

/* Which server to dial. Highest score in the country, skipping one the caller asked to avoid, which is how
 * `rotate` means anything on a pool this small: there is no signal to send, so a new address is a different
 * server or nothing. VPN Gate's own score already folds in speed, uptime and load, so re-ranking it here
 * would only be a worse version of what the project already computes. */
const pick = (servers: readonly VpngateServer[], country: string | undefined, avoid: string | undefined): VpngateServer | undefined => {
    const eligible = servers
        .filter((server) => country === undefined || server.country === country.toUpperCase())
        .toSorted((left, right) => right.score - left.score);
    return eligible.find((server) => server.host !== avoid) ?? eligible[0];
};

/* The decoded .ovpn plus the directives that make it safe and controllable here.
 *
 * `route-nopull` IS THE LOAD-BEARING LINE. Without it OpenVPN installs the server's pushed default route into
 * the MAIN table and the sandbox loses its own uplink the instant the tunnel comes up, which is the failure
 * this whole subsystem is built to avoid. With it, the interface comes up addressed and routes nothing; the
 * exit's private table and its `ip rule` are added afterwards by exit-tunnel.ts.
 *
 * The original `dev`/`daemon`/`log` lines are dropped rather than overridden: OpenVPN's precedence between a
 * repeated option and a later one is not something to bet a tunnel on.
 */
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
        // Ignore every pushed route and pushed DNS. The exit is reached through its proxy, never by default.
        "route-nopull",
        "dev-type tun",
        `dev ${exitInterface(id)}`,
        "daemon",
        `writepid ${pidPath(id)}`,
        `log ${logPath(id)}`,
        // SoftEther servers still present small RSA keys and old TLS, which OpenSSL 3 refuses at its default
        // security level. Lowering it for THIS connection only is the difference between the provider working
        // and every dial failing with an unreadable handshake error.
        "tls-cipher DEFAULT:@SECLEVEL=0",
        "data-ciphers AES-128-CBC:AES-256-GCM:AES-128-GCM",
        "verb 3",
        "",
    ].join("\n");
};

const livePid = async (id: string): Promise<number | undefined> => {
    const pid = await readPid(pidPath(id));
    return pid !== undefined && (await processAlive(pid, "openvpn")) ? pid : undefined;
};

// OpenVPN backgrounds itself once the tunnel is established, so the FOREGROUND exit code is the dial's
// verdict, the fortinet driver's pattern. Output goes straight to the log file rather than a pipe so the
// backgrounded grandchild keeps writing to it after this promise settles.
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

const halt = async (id: string): Promise<void> => {
    const pid = await livePid(id);
    if (pid !== undefined) {
        await exec("kill", ["-TERM", String(pid)]).catch(() => undefined);
    }
    await rm(pidPath(id), { force: true });
};

// Bring one server up: tear down whatever was there, write its config, dial, then publish the proxy. Shared
// by start and rotate because "move this exit to that server" is the same operation either way.
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
        // The client is up and addressed but this daemon has no proxy bound: a restart happened under a live
        // tunnel. Honest as "starting", and the boot restore's ensureProxy is what closes the gap.
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
