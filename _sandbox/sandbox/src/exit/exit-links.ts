import { sleep } from "@intentic/base/async";
import { errorMessage } from "@intentic/base/errors";
import type { Capability, ExitConfig, ExitLink, ExitObservation, IntenticLine } from "@intentic/sandbox-contract";
import type { CapabilitiesStore } from "../capabilities/capabilities-store.js";
import { countryName } from "./exit-countries.js";
import { exitDrivers } from "./exit-drivers.js";
import { exitProxyPort } from "./exit-paths.js";
import { forgetLiveState, markUp, readObservation, readSelection, upSince, writeObservation, writeSelection } from "./exit-state.js";
import { ensureProxy, proxyBound } from "./exit-tunnel.js";

/* The one place the manifest ("which exits exist") is joined to the machine ("which are up, and where do they
 * actually come out"). Everything that can move an exit, the Status card, the `exit` CLI, the capability
 * handler's apply, the browser wiring and the boot restore, goes through these functions, so there is exactly
 * one definition of what switching country means and no surface can drift from another.
 *
 * AND IT IS WHERE A SWITCH BECOMES TRUE. The drivers know how to bring a tunnel up; only this layer insists
 * that the tunnel came up WHERE IT WAS ASKED TO, by looking from the outside. A start or a use that cannot
 * prove its country takes the exit back down rather than leaving something running that a browser would
 * happily use while believing it was somewhere else.
 */

export interface ExitEntry {
    readonly id: string;
    readonly config: ExitConfig;
}

const exitEntries = (capabilities: readonly Capability[]): ExitEntry[] =>
    capabilities.flatMap((capability) => (capability.kind === "exit" ? [{ id: capability.id, config: capability.config }] : []));

export const proxyUrl = (id: string): string => `socks5://127.0.0.1:${exitProxyPort(id)}`;

// A fresh tunnel is not immediately usable, tor is still finishing circuits, an openvpn tunnel has just been
// addressed, so the first look often fails on something that works two seconds later. Retried rather than
// trusted, because "could not check" and "came out in the wrong country" must not be confused.
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

// One configured exit as the UI, the CLI and the browser wiring see it: manifest intent, the OS's answer, and
// the last observation. Cheap by design, the stored observation is read rather than re-made, because the
// Status card polls and every check is a real request through a volunteer relay.
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
        ...(probe.state === "up" ? { since: await upSince(entry.id) } : {}),
    };
};

export const exitLinks = async (capabilities: CapabilitiesStore): Promise<ExitLink[]> =>
    await Promise.all(exitEntries(await capabilities.list()).map((entry) => exitLink(entry)));

export const exitEntry = async (capabilities: CapabilitiesStore, id: string): Promise<ExitEntry | undefined> => {
    const capability = await capabilities.get(id);
    return capability === undefined || capability.kind !== "exit" ? undefined : { id: capability.id, config: capability.config };
};

/* Bring an exit up (or move it) at `country`, and prove it.
 *
 * The proof is the point. A driver reporting success means a tunnel exists; it does not mean traffic leaves
 * where it was asked to, and on tor in particular a country with too little capacity fails by quietly not
 * building circuits. So: start, look from the outside, and if the country does not match, STOP. Leaving a
 * mismatched exit running would be the worst of the options, a browser account bound to it would carry on
 * believing it was German while coming out of Amsterdam, which is precisely the failure this feature exists
 * to make impossible. */
export async function* startExit(entry: ExitEntry, country: string | undefined): AsyncGenerator<IntenticLine> {
    const driver = exitDrivers[entry.config.provider];
    const missing = await driver.missingTool();
    if (missing !== undefined) {
        throw new Error(
            `This sandbox doesn't carry ${missing} yet. Rebuild it from the Sandbox ▸ Environment card: the exit capability's image fragment installs it, and an auto-start exit comes up once the sandbox restarts.`,
        );
    }
    const wanted = country ?? entry.config.country;
    yield* driver.start(entry.id, entry.config, wanted);
    await markUp(entry.id);
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

/* ONE START PER EXIT AT A TIME, shared by everyone waiting on it.
 *
 * `startExit` is not safe to run twice concurrently against one id: both would write the same conf, dial the
 * same interface and race on the same proxy port, and the loser's failure would stop the winner's working
 * exit. Nothing needed this while every caller was a person clicking a button. It became load-bearing the
 * moment a start could be ABANDONED by its caller and left running (see resolveProfileExit's budget): a turn
 * that gives up waiting must leave the start in flight, and the next turn must join that one rather than
 * begin a second.
 *
 * Progress lines are dropped, not buffered. The callers that want them (the CLI, the Status card) stream
 * `startExit` directly; the callers that reach for this one only ever asked "is it up yet".
 */
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
    // Marks the rejection handled for the abandoned case. Callers still see the real failure through `run`;
    // without this, a start nobody is waiting on any more would crash the daemon as an unhandled rejection.
    void run.catch(() => undefined);
    starting.set(entry.id, run);
    return run;
};

// The driver already recorded which server it picked; preserve it when the links layer rewrites the selection
// with the confirmed country, or a rotate would lose track of what to avoid next time.
const selectionServer = async (id: string): Promise<{ server?: string }> => {
    const server = (await readSelection(id))?.server;
    return server === undefined ? {} : { server };
};

/* A different address in the same country. Fails when the address does not actually move: small pools really
 * do run out, and saying so is better than reporting a rotation that did nothing. Unlike a country mismatch
 * this leaves the exit UP, because an exit at the same address is still exactly what it claims to be. */
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

// Take an exit down. Tolerant by contract: the goal state is "not up", so an already-down exit is a success.
// The remembered observation goes with it, a stale reading outliving its tunnel would let `list` claim a
// country nothing is coming out of any more.
export const stopExit = async (entry: ExitEntry): Promise<void> => {
    await exitDrivers[entry.config.provider].stop(entry.id, entry.config).catch(() => undefined);
    await forgetLiveState(entry.id);
};

/* Boot restore, and a repair the vpn subsystem has no equivalent of.
 *
 * Two different things are wrong after a restart. Exits marked auto-start are down and want dialling, the
 * familiar half. But a tunnel-based exit's CLIENT survives the daemon (it is its own process) while its SOCKS
 * proxy does not, because that listener lived in the daemon: so there can be a live tunnel with nothing
 * publishing it. `ensureProxy` is idempotent precisely so that gap can be closed without touching the tunnel,
 * which is cheaper and far less disruptive than tearing a working exit down to rebuild it.
 *
 * Both halves are best-effort: a dead relay must not take the daemon down with it, so failures land in the
 * link's state and the log. */
export const restoreExits = async (
    capabilities: CapabilitiesStore,
    logger: { info: (message: string) => void; warn: (message: string) => void },
): Promise<void> => {
    for (const entry of exitEntries(await capabilities.list())) {
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
