import { spawn } from "node:child_process";
import { mkdir, open, readFile, rm, writeFile } from "node:fs/promises";
import { connect } from "node:net";
import { sleep } from "@intentic/base/async";
import type { ExitPoint, IntenticLine } from "@intentic/sandbox-contract";
import { halt as haltClient, livePid as livePidOf, logTail, toolMissing } from "../tunnel/net-probe.js";
import { rankCountries, TOR_FALLBACK } from "./exit-countries.js";
import type { ExitDriver, ExitProbe } from "./exit-driver.js";
import { observeThroughSocks } from "./exit-observe.js";
import {
    catalogPath,
    exitControlPort,
    exitDir,
    exitProxyPort,
    exitStateDir,
    logPath,
    pidPath,
    torCookiePath,
    torDataDir,
    torrcPath,
} from "./exit-paths.js";
import { writeSelection } from "./exit-state.js";

// Tor is the free default: no account or payment, country selection is a config line, a new address is a control-port
// signal, both applied in under a second.
// Needs no container privileges: tor publishes its own SOCKS port, no tun device, no routing table, no `ip rule`, so a
// tor-only sandbox never asks for NET_ADMIN.
// The cost: a large share of the web blocks Tor exits outright, and the bandwidth is donated, so this is for reading a
// page, not bulk crawling.

// Generous: bootstrapping on a cold consensus takes a while; failure carries the log's own tail.
const BOOTSTRAP_TIMEOUT_MS = 120_000;
// Tor rate-limits NEWNYM to one per 10s and silently ignores an early ask; waiting is the honest fix.
const NEWNYM_COOLDOWN_MS = 11_000;
const CONTROL_TIMEOUT_MS = 10_000;
const CATALOG_TTL_MS = 6 * 60 * 60 * 1000;
const ONIONOO_URL = "https://onionoo.torproject.org/details?type=relay&flag=Exit&running=true&fields=country,exit_probability";

// StrictNodes makes country a requirement, not a preference: without it tor treats ExitNodes as a hint and may leave
// from elsewhere, unnoticed.
export const exitNodesLine = (country: string | undefined): string =>
    country === undefined ? "" : `ExitNodes {${country.toLowerCase()}}\nStrictNodes 1\n`;

export const torrc = (id: string, country: string | undefined): string =>
    [
        `SocksPort 127.0.0.1:${exitProxyPort(id)}`,
        `ControlPort 127.0.0.1:${exitControlPort(id)}`,
        "CookieAuthentication 1",
        `CookieAuthFile ${torCookiePath(id)}`,
        `DataDirectory ${torDataDir(id)}`,
        `Log notice file ${logPath(id)}`,
        // A client, never a relay: an exit relay's address answers for whatever leaves it.
        "ClientOnly 1",
        "SocksPolicy accept 127.0.0.1/32",
        "SocksPolicy reject *",
        exitNodesLine(country),
    ]
        .filter((line) => line !== "")
        .join("\n")
        .concat("\n");

// One control-port conversation: authenticate with tor's own cookie, run the commands, hang up. A fresh connection per
// call, since the daemon outlives any single tor process.
const control = (id: string, commands: readonly string[]): Promise<string> =>
    new Promise((resolve, reject) => {
        void (async () => {
            const cookie = await readFile(torCookiePath(id)).catch(() => undefined);
            if (cookie === undefined) {
                reject(new Error("this exit's tor is not running (no control cookie), start it first"));
                return;
            }
            const socket = connect({ host: "127.0.0.1", port: exitControlPort(id) });
            let output = "";
            let stage = 0;
            const timer = setTimeout(() => {
                socket.destroy();
                reject(new Error("tor's control port did not answer in time"));
            }, CONTROL_TIMEOUT_MS);
            const done = (error?: Error): void => {
                clearTimeout(timer);
                socket.destroy();
                if (error === undefined) {
                    resolve(output);
                } else {
                    reject(error);
                }
            };
            socket.on("error", (error) => done(error));
            socket.on("connect", () => socket.write(`AUTHENTICATE ${cookie.toString("hex")}\r\n`));
            socket.on("data", (chunk) => {
                const text = chunk.toString("utf8");
                if (stage === 0) {
                    if (!text.startsWith("250")) {
                        done(new Error(`tor refused the control connection: ${text.trim()}`));
                        return;
                    }
                    stage = 1;
                    socket.write(`${commands.join("\r\n")}\r\nQUIT\r\n`);
                    return;
                }
                output += text;
                // Any non-"250" reply is tor rejecting the command; surfaced verbatim since it names what a country
                // lacks.
                const bad = output.split("\r\n").find((line) => /^[45]\d\d/.test(line));
                if (bad !== undefined) {
                    done(new Error(`tor refused: ${bad.trim()}`));
                    return;
                }
                if (output.includes("250 closing connection")) {
                    done();
                }
            });
            socket.on("close", () => done());
        })();
    });

// This driver's pidfile/process-name pair, bound to the shared liveness check.
const livePid = (id: string): Promise<number | undefined> => livePidOf(pidPath(id), "tor");

// Reads the log rather than polling SOCKS: the port opens and accepts connections before tor can actually build a
// circuit.
const awaitBootstrap = async (id: string): Promise<void> => {
    const deadline = Date.now() + BOOTSTRAP_TIMEOUT_MS;
    for (;;) {
        const log = await readFile(logPath(id), "utf8").catch(() => "");
        if (/Bootstrapped 100%/.test(log)) {
            return;
        }
        if ((await livePid(id)) === undefined) {
            throw new Error(`tor exited while starting up.\n${await logTail(logPath(id))}`);
        }
        if (Date.now() >= deadline) {
            throw new Error(`tor did not finish bootstrapping within ${BOOTSTRAP_TIMEOUT_MS / 1000}s.\n${await logTail(logPath(id))}`);
        }
        await sleep(500);
    }
};

// The exit-relay census, off the Tor Project's own directory. Ranked by exit probability, not relay count: a country
// can run many low-bandwidth relays and still carry a small share of traffic.
const fetchCatalog = async (): Promise<ExitPoint[] | undefined> => {
    const response = await fetch(ONIONOO_URL, { signal: AbortSignal.timeout(20_000) }).catch(() => undefined);
    if (response === undefined || !response.ok) {
        return undefined;
    }
    const body = (await response.json().catch(() => undefined)) as { relays?: { country?: string; exit_probability?: number }[] } | undefined;
    const relays = body?.relays;
    if (relays === undefined || relays.length === 0) {
        return undefined;
    }
    const counts = new Map<string, number>();
    const shares = new Map<string, number>();
    for (const relay of relays) {
        if (relay.country === undefined) {
            continue;
        }
        const code = relay.country.toUpperCase();
        counts.set(code, (counts.get(code) ?? 0) + 1);
        shares.set(code, (shares.get(code) ?? 0) + (relay.exit_probability ?? 0));
    }
    // rankCountries sorts by relay count; re-sorted here by exit probability, the axis a user actually feels.
    const shared: ExitPoint[] = rankCountries(counts).map((point) => ({
        country: point.country,
        countryName: point.countryName,
        servers: point.servers,
        share: shares.get(point.country) ?? 0,
    }));
    return shared.toSorted((a, b) => (b.share ?? 0) - (a.share ?? 0) || b.servers - a.servers);
};

const cachedCatalog = async (): Promise<{ countries: readonly ExitPoint[]; live: boolean }> => {
    const path = catalogPath("tor");
    const cached = await readFile(path, "utf8")
        .then((raw) => JSON.parse(raw) as { at: number; countries: ExitPoint[] })
        .catch(() => undefined);
    if (cached !== undefined && Date.now() - cached.at < CATALOG_TTL_MS) {
        return { countries: cached.countries, live: true };
    }
    const fresh = await fetchCatalog();
    if (fresh === undefined) {
        // A cache past its TTL still beats the baked list: it's this network, only a few hours stale.
        return cached === undefined ? { countries: TOR_FALLBACK, live: false } : { countries: cached.countries, live: false };
    }
    await mkdir(exitDir(), { recursive: true, mode: 0o700 }).catch(() => undefined);
    await writeFile(path, JSON.stringify({ at: Date.now(), countries: fresh }), { mode: 0o600 }).catch(() => undefined);
    return { countries: fresh, live: true };
};

const launch = async (id: string, country: string | undefined): Promise<void> => {
    await mkdir(torDataDir(id), { recursive: true, mode: 0o700 });
    await writeFile(torrcPath(id), torrc(id, country), { mode: 0o600 });
    await rm(logPath(id), { force: true });
    const handle = await open(logPath(id), "a", 0o600);
    try {
        const child = spawn("tor", ["-f", torrcPath(id)], { stdio: ["ignore", handle.fd, handle.fd], detached: true });
        if (child.pid === undefined) {
            throw new Error("tor could not be started");
        }
        await writeFile(pidPath(id), String(child.pid), { mode: 0o600 });
        // Detached and unref'd: tor outlives the turn that started it; the daemon must not hold its event loop open.
        child.unref();
    } finally {
        await handle.close();
    }
};

const halt = (id: string): Promise<void> => haltClient(pidPath(id), "tor");

// SETCONF alone isn't enough: it governs circuits built from now on, and existing ones keep their exit, so NEWNYM must
// follow or the next request comes out of the old country.
const aim = async (id: string, country: string | undefined): Promise<void> => {
    await control(id, [
        country === undefined ? "RESETCONF ExitNodes\r\nRESETCONF StrictNodes" : `SETCONF ExitNodes="{${country.toLowerCase()}}" StrictNodes=1`,
        "SIGNAL NEWNYM",
    ]);
    // Rewritten too, so a tor restarted by the boot restore comes up aimed where it last was.
    await writeFile(torrcPath(id), torrc(id, country), { mode: 0o600 }).catch(() => undefined);
};

export const torDriver: ExitDriver = {
    catalog: async () => await cachedCatalog(),
    write: async (id) => {
        await mkdir(exitStateDir(id), { recursive: true, mode: 0o700 });
    },
    erase: async (id) => {
        await rm(exitStateDir(id), { recursive: true, force: true });
    },
    missingTool: async () => ((await toolMissing("tor", ["--version"])) ? "tor" : undefined),
    async *start(id, config, country): AsyncGenerator<IntenticLine> {
        const wanted = country ?? config.country;
        if ((await livePid(id)) !== undefined) {
            // Already running: this is a move, not a second tor, and cheap, unlike a fresh bootstrap.
            yield { kind: "log", message: `Re-aiming ${id}${wanted === undefined ? " (any country)" : ` at ${wanted}`}…` };
            await aim(id, wanted);
            await writeSelection(id, { country: wanted });
            return;
        }
        yield { kind: "log", message: `Starting tor for ${id}${wanted === undefined ? "" : ` at ${wanted}`}…` };
        await launch(id, wanted);
        yield { kind: "log", message: "Bootstrapping onto the Tor network (this takes a few seconds)…" };
        await awaitBootstrap(id);
        await writeSelection(id, { country: wanted });
        yield { kind: "log", message: `tor is up. SOCKS proxy on 127.0.0.1:${exitProxyPort(id)}.` };
    },
    async *rotate(id): AsyncGenerator<IntenticLine> {
        if ((await livePid(id)) === undefined) {
            throw new Error(`${id} is not running, start it before rotating.`);
        }
        yield { kind: "log", message: "Asking tor for fresh circuits…" };
        await control(id, ["SIGNAL NEWNYM"]);
        // Tor silently drops a NEWNYM asked within 10s of the last; the wait makes a second rotate mean anything.
        await sleep(NEWNYM_COOLDOWN_MS);
    },
    stop: async (id) => {
        await halt(id);
    },
    probe: async (id): Promise<ExitProbe> => {
        if ((await livePid(id)) === undefined) {
            if (await toolMissing("tor", ["--version"])) {
                return { state: "unavailable" };
            }
            const log = await logTail(logPath(id), 4);
            // A log with content and no live process is a failed start; the reason is worth carrying up.
            return log === "" ? { state: "down" } : { state: "failed", detail: log.split("\n").at(-1) };
        }
        const log = await readFile(logPath(id), "utf8").catch(() => "");
        return /Bootstrapped 100%/.test(log) ? { state: "up" } : { state: "starting" };
    },
    observe: async (id) => await observeThroughSocks(exitProxyPort(id)),
};
