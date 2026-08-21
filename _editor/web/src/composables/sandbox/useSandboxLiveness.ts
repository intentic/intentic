import { watch } from "vue";
import { desyncAgents } from "../agents/useAgents";
import { queryClient } from "../queryPersistence";
import { presenceStreamOpened, resetPresence } from "../usePresence";
import { markWorkspaceChanged } from "../workspace/useWorkspaceLive";
import { classifyFailure, type ConnectionFailure, watchdogRecoveryDelay } from "./connection";
import { daemonErrorMessage, daemonErrorStatus, sandboxRpc, SandboxUnaddressedError } from "./sandboxRpc";
import { useSandboxSession } from "./sandboxSession";
import { applySystemEvent } from "./systemEvents";
import { sandboxQueryPredicate } from "./systemEventRouting";
import { resetDaemonBoot } from "./useDaemonBoot";
import { resetDaemonRoutes } from "./useDaemonRoutes";
import { useEndpoint } from "./useEndpoint";
import { signalConnection, useSandbox } from "./useSandbox";
import { uuid } from "../uuid";

/* The DRIVER: hold one long-lived `/events` stream open to the active sandbox daemon, and reconnect when it
 * breaks. Everything it used to ALSO do now lives next door, the transition rules in connection.ts (pure,
 * tested), the frame routing in systemEvents.ts (typed, tested), so what is left here is exactly the part
 * that genuinely needs the network: opening the stream, watching for silence, and sleeping between attempts.
 *
 * The stream is the typed oRPC event iterator, not a hand-parsed SSE body: the daemon has always declared
 * /events as `eventIterator(SystemEventSchema)`, and sandboxRpc decodes it back into that union. A frame is a
 * `SystemEvent` on arrival, so there is no framing to reassemble and no safeParse re-deriving types the
 * contract already had.
 *
 * Started by the workspace shell for the lifetime of the post-login session. Module-level singleton. */

// No frame for this long means the connection silently half-opened (origin gone without a TCP FIN), trip
// offline. The daemon emits a heartbeat every ~2s, so this tolerates ~4 missed beats before reconnecting.
// Sized for a daemon on a REAL machine, not an idealized one: a container under build/test IO pressure
// legitimately misses a couple of beats, and at 6s (the old value) every such blip tore the stream down and
// flashed the workspace to the reconnect gate. Detection of a genuinely dead sandbox arrives 4s later; a
// stall is ridden out invisibly.
const WATCHDOG_MS = 10_000;

const { daemonUrl, connection, activeSandboxId, refresh } = useSandbox();
const { daemonBase, usingLocal, resolve: resolveEndpoint, demote: demoteEndpoint, reset: resetEndpoint } = useEndpoint();
const { invalidateSession } = useSandboxSession();

let running = false;
let controller: AbortController | undefined;
let watchdog: ReturnType<typeof setTimeout> | undefined;
// Set when the abort came from the watchdog rather than the network, so the failure is CLASSIFIED as a timeout
// instead of being sniffed out of `error.name === "AbortError"` after the fact, the two are identical at the
// error object, because the watchdog aborts the very same request.
let watchdogTripped = false;
// Resolver of the in-flight sleep, so a sandbox switch cuts a backoff short instead of stalling the reconnect
// against the new daemon for up to the ceiling.
let wake: (() => void) | undefined;
// Last observed reachability per sandbox id: switching back to a recently-healthy sandbox renders the
// workspace immediately (stale-while-revalidate) while the stream re-establishes; a wrong guess self-corrects
// on the first failed connect or watchdog trip.
const lastKnown = new Map<string, boolean>();

const sleep = (ms: number): Promise<void> =>
    new Promise((resolve) => {
        wake = resolve;
        setTimeout(resolve, ms);
    });

const clearWatchdog = (): void => {
    if (watchdog !== undefined) {
        clearTimeout(watchdog);
        watchdog = undefined;
    }
};

const armWatchdog = (delayMs = WATCHDOG_MS): void => {
    clearWatchdog();
    const dueAt = performance.now() + delayMs;
    watchdog = setTimeout(() => {
        const recoveryDelay = watchdogRecoveryDelay(performance.now() - dueAt);
        if (recoveryDelay > 0) {
            // The browser main thread, not the stream, went silent. A queued frame gets to re-arm the ordinary
            // watchdog before this grace fires; if none arrives, this callback is on-time and trips normally.
            armWatchdog(recoveryDelay);
            return;
        }
        watchdogTripped = true;
        controller?.abort();
    }, delayMs);
};

const failureOf = (error: unknown): ConnectionFailure => {
    if (error instanceof SandboxUnaddressedError) {
        return classifyFailure({ unaddressed: true, message: error.message });
    }
    if (watchdogTripped) {
        return classifyFailure({ watchdog: true, message: `The sandbox stopped responding.` });
    }
    return classifyFailure({ status: daemonErrorStatus(error), message: daemonErrorMessage(error) });
};

// Did the active sandbox move out from under an in-flight attempt? A deliberate switch aborts the stream, and
// that abort must not be written onto the sandbox the user just moved TO.
const switchedDuring = (sandboxId: string): boolean => activeSandboxId.value !== sandboxId;

// Did the ADDRESS move out from under an in-flight attempt? Promoting to the loopback shortcut aborts the
// stream on purpose (see the watch below), and that abort is not the sandbox failing, checked BEFORE the
// demotion branch, or a promotion would read its own abort as "local is broken" and immediately undo itself.
const retargetedDuring = (base: string | undefined): boolean => daemonBase.value !== base;

// Consume the stream until it ends or breaks. Returns normally only when the daemon closed it cleanly, a
// healthy stream never does, so the caller treats that as its own throttled failure rather than a success.
const stream = async (sandboxId: string): Promise<void> => {
    controller = new AbortController();
    watchdogTripped = false;
    // Armed before the connect, not just after: a hung connect (a dead tunnel that neither answers nor
    // refuses) must not leave the optimistic paint up, the watchdog trips it and aborts.
    armWatchdog();
    // Per-CONNECTION presence id, never reused across attempts: the daemon keys this tab's roster entry by it,
    // so a lingering old connection's teardown can only ever remove its own entry, never this one's.
    const clientId = uuid();
    const frames = await sandboxRpc.system.events({ clientId }, { signal: controller.signal });
    signalConnection({ kind: `opened` });
    armWatchdog();
    // The daemon just registered this connection's blank roster entry, announce the tab's current activity.
    presenceStreamOpened(clientId);
    // Reconnect recovery: refetch the tree on every (re)connect, since file changes during a disconnect carried
    // no frame. Empty paths = "just refetch" (no per-file re-read/highlight, we don't know what was missed).
    markWorkspaceChanged([]);
    for await (const frame of frames) {
        signalConnection({ kind: `frame` });
        armWatchdog();
        applySystemEvent(frame, sandboxId);
    }
};

// One attempt, from "we have an address" to a settled outcome. Nothing here decides how long to wait next,
// that is the machine's `retryDelayMs`.
const attempt = async (): Promise<void> => {
    // Need the daemon's address to open the stream, reload the sandbox list if we don't have one yet. A
    // rejected platform call must not escape (it would kill liveness for good, with `running` still true so
    // start() never restarts it); the failure signals below cover it.
    if (daemonUrl.value === undefined) {
        await refresh().catch(() => undefined);
    }
    const sandboxId = activeSandboxId.value;
    if (sandboxId === undefined) {
        signalConnection({
            kind: `failed`,
            failure: classifyFailure({ unaddressed: true, message: `No sandbox is selected.` }),
            at: Date.now(),
        });
        return;
    }
    /* Still no address after the refresh, so say that, BEFORE signalling `connect`. Reaching the try below
     * without one is not an attempt that happens to fail: `sandboxRpc` cannot build a URL, and the first thing
     * it does on the way to finding that out is ask for a bearer, which raises the browser→sandbox Google
     * sign-in gate. So a sandbox that was named and never started asked the user to sign in to reach it, and
     * behind that prompt the connecting gate read "Your sandbox reported in", the optimistic copy the
     * `connect` signal paints, about a machine that has never spoken to us.
     *
     * `unaddressed` is exactly this condition and already has honest words for it ("isn't connected yet,
     * finish setup"), with setup as its offered action. It just has to be reached without pretending first. */
    if (daemonUrl.value === undefined) {
        signalConnection({
            kind: `failed`,
            failure: classifyFailure({ unaddressed: true, message: `This sandbox has never reported an address.` }),
            at: Date.now(),
        });
        return;
    }
    // Qualify the fastest address for this sandbox IN THE BACKGROUND, never awaited, so a hung loopback
    // probe cannot delay the connect. The attempt below opens against the tunnel (or an already-resolved
    // shortcut); if the probe qualifies mid-stream the watch at the bottom retargets us onto it.
    void resolveEndpoint().catch(() => undefined);
    // The address this attempt is bound to, so its own deliberate abort can be told from a real break.
    const base = daemonBase.value;
    signalConnection({ kind: `connect` });
    try {
        await stream(sandboxId);
        if (!running || switchedDuring(sandboxId)) {
            return;
        }
        if (retargetedDuring(base)) {
            signalConnection({ kind: `retargeted` });
            return;
        }
        // The daemon answered and then closed the body without erroring. Reported as a failure so the machine
        // throttles the next attempt, otherwise a 200-then-immediately-close daemon is a zero-delay hot loop.
        signalConnection({
            kind: `failed`,
            failure: classifyFailure({ closed: true, message: `The sandbox closed the connection.` }),
            at: Date.now(),
        });
    } catch (error) {
        if (!running || switchedDuring(sandboxId)) {
            return;
        }
        if (retargetedDuring(base)) {
            signalConnection({ kind: `retargeted` });
            return;
        }
        // The shortcut stopped answering (docker restarted, the machine slept, this browser moved to another
        // network than the container). The tunnel is known-good, so this is a repair rather than an outage:
        // fall back and retry AT ONCE instead of backing off against an address we have just abandoned. The
        // retarget check above already excluded a deliberate abort, so reaching here means it really failed.
        if (usingLocal.value) {
            demoteEndpoint(sandboxId);
            signalConnection({ kind: `retargeted` });
            return;
        }
        const failure = failureOf(error);
        signalConnection({ kind: `failed`, failure, at: Date.now() });
        if (failure.kind === `unauthenticated`) {
            // The daemon rejected the bearer we hold (session secret rotated, expiry raced the margin). Drop
            // the session so the fast retry re-establishes from a Google proof instead of replaying a dead one.
            invalidateSession();
        }
        if (failure.kind === `forbidden`) {
            // A revoked member must not keep a cached (IndexedDB-persisted) copy of the sandbox on disk.
            queryClient.removeQueries({ predicate: sandboxQueryPredicate(sandboxId) });
        }
        // Presence is a claim about who is here NOW, meaningless while disconnected, so it clears. The agents
        // roster only DESYNCS: the revision guard resets (a restarted daemon's counter starts over, and a held
        // high-water mark would reject its every frame) while the painted list stays up, stale, until the
        // reconnect's immediate snapshot overwrites it, blanking the chat list for every reconnect is what
        // used to turn a two-heartbeat stall into a visible outage.
        resetPresence();
        desyncAgents();
        // A restarted sandbox may have re-registered a fresh daemonUrl, pick it up before retrying. Swallowed
        // on failure for the same reason as the refresh above: the next attempt handles it.
        await refresh().catch(() => undefined);
    } finally {
        clearWatchdog();
    }
};

// `for (;;)` rather than `while (running)`: `running` is flipped by stop(), from outside this function, so a
// loop condition on it proves nothing to a reader, the two explicit exits are where stopping takes effect.
const loop = async (): Promise<void> => {
    for (;;) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- a reconnect loop is sequential by definition
        await attempt();
        if (!running) {
            return;
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- ditto: the backoff IS the loop
        await sleep(connection.value.retryDelayMs);
        if (!running) {
            return;
        }
    }
};

const start = (): void => {
    if (running) {
        return;
    }
    running = true;
    void loop();
};

const stop = (): void => {
    running = false;
    signalConnection({ kind: `disconnect` });
    controller?.abort();
    clearWatchdog();
};

// Re-probe the moment the active sandbox changes: remember the outgoing sandbox's state, prime the machine
// with the incoming one's last known state, and abort the stream / wake the backoff so the loop reconnects
// against the new daemonUrl right away.
watch(activeSandboxId, (id, previous) => {
    if (previous !== undefined) {
        lastKnown.set(previous, connection.value.phase === `online`);
    }
    // Switching away and back is the user's own "try again" for a shortcut that was demoted earlier in this
    // session, the machine they are on may well have changed since.
    if (id !== undefined) {
        resetEndpoint(id);
    }
    signalConnection({ kind: `switched`, lastKnownOnline: id !== undefined && (lastKnown.get(id) ?? false) });
    // Another sandbox runs another image, on its own clock, attributing the outgoing daemon's route surface
    // to it would hide or invent features on the incoming one, and its boot state would gate (or ungate) the
    // wrong daemon's reads. Both re-report on the next hello.
    resetDaemonRoutes();
    resetDaemonBoot();
    controller?.abort();
    wake?.();
});

// The address changed under the open stream, the loopback shortcut qualified (promotion), the daemon
// re-announced a new URL, or a demotion put us back on the tunnel. Abort so the loop reconnects against it
// immediately: the alternative is a stream that keeps running on the address we stopped choosing, for as long
// as it happens to stay healthy. The attempt itself tells this abort from a real break (retargetedDuring).
watch(daemonBase, () => {
    controller?.abort();
    wake?.();
});

export function useSandboxLiveness() {
    return { start, stop };
}
