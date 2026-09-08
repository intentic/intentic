import { sleep } from "@intentic/base/async";
import { errorMessage } from "@intentic/base/errors";
import type { ExitConfig, ExitLink, ExitObservation, IntenticLine } from "@intentic/sandbox-contract";
import type { CapabilitiesStore } from "../capabilities/capabilities-store.js";
import { notCarriedYet, type TunnelEntry, tunnelEntries } from "../tunnel/tunnel-links.js";
import { markUp, upSince } from "../tunnel/tunnel-state.js";
import { countryName } from "./exit-countries.js";
import { exitDrivers } from "./exit-drivers.js";
import { exitProxyPort, exitStateDir, upMarkerPath } from "./exit-paths.js";
import { forgetLiveState, readObservation, readSelection, writeObservation, writeSelection } from "./exit-state.js";
import { ensureProxy, proxyBound } from "./exit-tunnel.js";

// Joins the manifest (which exits exist) to the machine (which are up, and where they actually come out); every
// caller that can move an exit (capability card, `exit` CLI, capability handler, browser wiring, boot restore)
// goes through these functions. Where a switch becomes true: a start that can't prove its country takes the exit
// back down rather than leave it running under a wrong belief.

export type ExitEntry = TunnelEntry<ExitConfig>;

export const proxyUrl = (id: string): string => `socks5://127.0.0.1:${exitProxyPort(id)}`;

// Fresh tunnels fail their first look (tor circuits, openvpn addressing); retry before trusting.
const OBSERVE_ATTEMPTS = 3;
const OBSERVE_BACKOFF_MS = 2_000;

const observeWithRetry = async (entry: ExitEntry): Promise<ExitObservation> => {
    const driver = exitDrivers[entry.config.provider];
    let last: Error | undefined;
    for (let attempt = 0; attempt < OBSERVE_ATTEMPTS; attempt += 1) {
        try {
            const seen = await driver.observe(entry.id, entry.config);
            await writeObservation(entry.id, seen, Date.now());
            return seen;
        } catch (error) {
            last = error instanceof Error ? error : new Error(String(error));
            await sleep(OBSERVE_BACKOFF_MS * (attempt + 1));
        }
    }
    throw last ?? new Error("could not read this exit's public address");
};

// One exit as the UI, CLI and browser wiring see it: manifest intent, the OS's answer, and the last observation.
// Reads the stored observation rather than re-probing, since the capability card polls and each check is a real
// request through a volunteer relay.
export const exitLink = async (entry: ExitEntry): Promise<ExitLink> => {
    const driver = exitDrivers[entry.config.provider];
    const probe = await driver.probe(entry.id, entry.config);
    const selection = await readSelection(entry.id);
    const observed = probe.state === "up" || probe.state === "starting" ? await readObservation(entry.id) : undefined;
    const country = selection?.country ?? entry.config.country;
    return {
        id: entry.id,
        provider: entry.config.provider,
        state: probe.state,
        proxy: proxyUrl(entry.id),
        autoStart: entry.config.autoStart === "on",
        ...(country === undefined ? {} : { country }),
        ...(observed === undefined
            ? {}
            : {
                  ip: observed.seen.ip,
                  checkedAt: observed.at,
                  ...(observed.seen.country === undefined ? {} : { observedCountry: observed.seen.country }),
              }),
        ...(probe.interface === undefined ? {} : { interface: probe.interface }),
        ...(probe.detail === undefined ? {} : { detail: probe.detail }),
        ...(probe.state === "up" ? { since: await upSince(upMarkerPath(entry.id)) } : {}),
    };
};

export const exitLinks = async (capabilities: CapabilitiesStore): Promise<ExitLink[]> =>
    await Promise.all(tunnelEntries(await capabilities.list(), "exit").map((entry) => exitLink(entry)));

// Brings an exit up (or moves it) at `country`, and proves it: a driver reporting success only means a tunnel
// exists, not that traffic leaves where asked (tor especially fails quietly when a country lacks capacity). Stops
// the exit rather than leave a mismatched one running under a false belief.
export async function* startExit(entry: ExitEntry, country: string | undefined): AsyncGenerator<IntenticLine> {
    const driver = exitDrivers[entry.config.provider];
    const missing = await driver.missingTool();
    if (missing !== undefined) {
        throw notCarriedYet(missing, "exit");
    }
    const wanted = country ?? entry.config.country;
    yield* driver.start(entry.id, entry.config, wanted);
    await markUp(exitStateDir(entry.id), upMarkerPath(entry.id));
    yield { kind: "log", message: "Checking where this comes out…" };
    let seen: ExitObservation;
    try {
        seen = await observeWithRetry(entry);
    } catch (error) {
        await stopExit(entry);
        throw new Error(
            `${entry.id} came up but its public address could not be read, so there is no way to say where it comes out. Stopped it rather than leave it running unverified.\n${errorMessage(error)}`,
            { cause: error },
        );
    }
    if (wanted !== undefined && seen.country !== undefined && seen.country !== wanted.toUpperCase()) {
        await stopExit(entry);
        throw new Error(
            `${entry.id} was asked for ${countryName(wanted)} but came out in ${seen.countryName ?? seen.country} (${seen.ip}). Stopped it: an exit in the wrong country is worse than none, because everything pointed at it would believe otherwise.${
                entry.config.provider === "tor"
                    ? ` Tor could not hold a circuit through ${wanted.toUpperCase()}; that usually means the country has too little exit capacity right now.`
                    : ""
            }`,
        );
    }
    await writeSelection(entry.id, { ...(wanted === undefined ? {} : { country: wanted.toUpperCase() }), ...(await selectionServer(entry.id)) });
    yield {
        kind: "log",
        message: `${entry.id} is up: ${seen.ip}${seen.countryName === undefined ? "" : ` · ${seen.countryName}`}. Point things at ${proxyUrl(entry.id)}.`,
    };
}

// One start per exit id at a time, shared by every caller: two concurrent starts would race on the same conf,
// interface and proxy port. Needed because a caller can abandon a start and leave it running (resolveProfileExit's
// budget); the next turn must join the in-flight one rather than begin a second. Progress lines are dropped, not
// buffered, callers wanting them stream `startExit` directly.
const starting = new Map<string, Promise<void>>();

export const startExitOnce = (entry: ExitEntry, country: string | undefined): Promise<void> => {
    const inFlight = starting.get(entry.id);
    if (inFlight !== undefined) {
        return inFlight;
    }
    const run = (async () => {
        for await (const line of startExit(entry, country)) {
            void line;
        }
    })().finally(() => starting.delete(entry.id));
    // Marks the rejection handled for the abandoned case; without it, a start nobody is waiting on any more crashes
    // the daemon as an unhandled rejection.
    void run.catch(() => undefined);
    starting.set(entry.id, run);
    return run;
};

// The driver already recorded which server it picked; preserve it when rewriting the selection with the confirmed
// country, or a rotate loses track of what to avoid next time.
const selectionServer = async (id: string): Promise<{ server?: string }> => {
    const server = (await readSelection(id))?.server;
    return server === undefined ? {} : { server };
};

// A different address in the same country. Fails if the address doesn't actually move (small pools run out);
// unlike a country mismatch, leaves the exit up, since it's still what it claims to be.
export async function* rotateExit(entry: ExitEntry): AsyncGenerator<IntenticLine> {
    const before = (await readObservation(entry.id))?.seen.ip;
    yield* exitDrivers[entry.config.provider].rotate(entry.id, entry.config);
    const seen = await observeWithRetry(entry);
    if (before !== undefined && seen.ip === before) {
        throw new Error(
            `${entry.id} still comes out of ${seen.ip}. ${
                entry.config.provider === "tor"
                    ? "Tor reused the same exit relay; try again in a few seconds, or narrow to a country with more relays."
                    : "This pool has no other server to move to in that country."
            }`,
        );
    }
    yield { kind: "log", message: `${entry.id} moved to ${seen.ip}${seen.countryName === undefined ? "" : ` · ${seen.countryName}`}.` };
}

export const checkExit = async (entry: ExitEntry): Promise<ExitObservation> => await observeWithRetry(entry);

// Tolerant by contract: an already-down exit is a success. Clears the remembered observation too, or a stale
// reading would let `list` claim a country nothing comes out of any more.
export const stopExit = async (entry: ExitEntry): Promise<void> => {
    await exitDrivers[entry.config.provider].stop(entry.id, entry.config).catch(() => undefined);
    await forgetLiveState(entry.id);
};

// Boot restore, plus a repair the vpn subsystem has no equivalent of: a tunnel-based exit's client process
// survives a daemon restart, but its SOCKS proxy lived in the daemon and does not, so a live tunnel can end up
// with nothing publishing it. `ensureProxy` is idempotent so that gap closes without touching the tunnel. Both
// this and the ordinary autostart dial are best-effort: a dead relay must not take the daemon down with it.
export const restoreExits = async (
    capabilities: CapabilitiesStore,
    logger: { info: (message: string) => void; warn: (message: string) => void },
): Promise<void> => {
    for (const entry of tunnelEntries(await capabilities.list(), "exit")) {
        const driver = exitDrivers[entry.config.provider];
        const probe = await driver.probe(entry.id, entry.config).catch(() => undefined);
        if (probe === undefined) {
            continue;
        }
        // A live tunnel whose proxy died with the last daemon: re-publish it and leave everything else alone.
        if ((probe.state === "up" || probe.state === "starting") && probe.interface !== undefined && !proxyBound(entry.id)) {
            await ensureProxy(entry.id).then(
                () => logger.info(`exit ${entry.id}: re-published its proxy over a tunnel that outlived the daemon`),
                (error: unknown) => logger.warn(`exit ${entry.id}: could not re-publish its proxy: ${errorMessage(error)}`),
            );
            continue;
        }
        if (entry.config.autoStart !== "on" || probe.state === "up" || probe.state === "starting") {
            continue;
        }
        try {
            // Where it was last put, not where the manifest rests: a user who moved an exit to Japan for a job
            // expects to find it in Japan after a restart, not back at its default.
            const last = (await readSelection(entry.id))?.country;
            for await (const line of startExit(entry, last ?? entry.config.country)) {
                void line;
            }
            logger.info(`exit ${entry.id}: started`);
        } catch (error) {
            logger.warn(`exit ${entry.id}: could not start: ${errorMessage(error)}`);
        }
    }
};
