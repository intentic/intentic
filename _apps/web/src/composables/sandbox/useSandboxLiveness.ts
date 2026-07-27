import { watch } from "vue";
import { resetAgents } from "../agents/useAgents";
import { queryClient } from "../queryPersistence";
import { presenceStreamOpened, resetPresence } from "../usePresence";
import { markWorkspaceChanged } from "../workspace/useWorkspaceLive";
import { classifyFailure, type ConnectionFailure } from "./connection";
import { daemonErrorMessage, daemonErrorStatus, sandboxRpc, SandboxUnaddressedError } from "./sandboxRpc";
import { applySystemEvent } from "./systemEvents";
import { sandboxQueryPredicate } from "./systemEventRouting";
import { resetDaemonRoutes } from "./useDaemonRoutes";
import { signalConnection, useSandbox } from "./useSandbox";

/* The DRIVER: hold one long-lived `/events` stream open to the active sandbox daemon, and reconnect when it
 * breaks. Everything it used to ALSO do now lives next door — the transition rules in connection.ts (pure,
 * tested), the frame routing in systemEvents.ts (typed, tested) — so what is left here is exactly the part
 * that genuinely needs the network: opening the stream, watching for silence, and sleeping between attempts.
 *
 * The stream is the typed oRPC event iterator, not a hand-parsed SSE body: the daemon has always declared
 * /events as `eventIterator(SystemEventSchema)`, and sandboxRpc decodes it back into that union. A frame is a
 * `SystemEvent` on arrival, so there is no framing to reassemble and no safeParse re-deriving types the
 * contract already had.
 *
 * Started by the workspace shell for the lifetime of the post-login session. Module-level singleton. */

// No frame for this long means the connection silently half-opened (origin gone without a TCP FIN) — trip
// offline. The daemon emits a heartbeat every ~2s, so this tolerates ~2 missed beats before reconnecting.
const WATCHDOG_MS = 6000;

const { daemonUrl, connection, activeSandboxId, refresh } = useSandbox();

let running = false;
let controller: AbortController | undefined;
let watchdog: ReturnType<typeof setTimeout> | undefined;
// Set when the abort came from the watchdog rather than the network, so the failure is CLASSIFIED as a timeout
// instead of being sniffed out of `error.name === "AbortError"` after the fact — the two are identical at the
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

const armWatchdog = (): void => {
    clearWatchdog();
    watchdog = setTimeout(() => {
        watchdogTripped = true;
        controller?.abort();
    }, WATCHDOG_MS);
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

// Consume the stream until it ends or breaks. Returns normally only when the daemon closed it cleanly — a
// healthy stream never does, so the caller treats that as its own throttled failure rather than a success.
const stream = async (sandboxId: string): Promise<void> => {
    controller = new AbortController();
    watchdogTripped = false;
    // Armed before the connect, not just after: a hung connect (a dead tunnel that neither answers nor
    // refuses) must not leave the optimistic paint up — the watchdog trips it and aborts.
    armWatchdog();
    // Per-CONNECTION presence id, never reused across attempts: the daemon keys this tab's roster entry by it,
    // so a lingering old connection's teardown can only ever remove its own entry, never this one's.
    const clientId = crypto.randomUUID();
    const frames = await sandboxRpc.system.events({ clientId }, { signal: controller.signal });
    signalConnection({ kind: `opened` });
    armWatchdog();
    // The daemon just registered this connection's blank roster entry — announce the tab's current activity.
    presenceStreamOpened(clientId);
    // Reconnect recovery: refetch the tree on every (re)connect, since file changes during a disconnect carried
    // no frame. Empty paths = "just refetch" (no per-file re-read/highlight — we don't know what was missed).
    markWorkspaceChanged([]);
    for await (const frame of frames) {
        signalConnection({ kind: `frame` });
        armWatchdog();
        applySystemEvent(frame, sandboxId);
    }
};

// One attempt, from "we have an address" to a settled outcome. Nothing here decides how long to wait next —
// that is the machine's `retryDelayMs`.
const attempt = async (): Promise<void> => {
    // Need the daemon's address to open the stream — reload the sandbox list if we don't have one yet. A
    // rejected platform call must not escape (it would kill liveness for good, with `running` still true so
    // start() never restarts it); the failure signals below cover it.
    if (daemonUrl.value === undefined) {
        await refresh().catch(() => undefined);
    }
    const sandboxId = activeSandboxId.value;
    if (sandboxId === undefined) {
        signalConnection({ kind: `failed`, failure: classifyFailure({ unaddressed: true, message: `No sandbox is selected.` }) });
        return;
    }
    signalConnection({ kind: `connect` });
    try {
        await stream(sandboxId);
        if (!running || switchedDuring(sandboxId)) {
            return;
        }
        // The daemon answered and then closed the body without erroring. Reported as a failure so the machine
        // throttles the next attempt — otherwise a 200-then-immediately-close daemon is a zero-delay hot loop.
        signalConnection({ kind: `failed`, failure: classifyFailure({ closed: true, message: `The sandbox closed the connection.` }) });
    } catch (error) {
        if (!running || switchedDuring(sandboxId)) {
            return;
        }
        const failure = failureOf(error);
        signalConnection({ kind: `failed`, failure });
        if (failure.kind === `forbidden`) {
            // A revoked member must not keep a cached (IndexedDB-persisted) copy of the sandbox on disk.
            queryClient.removeQueries({ predicate: sandboxQueryPredicate(sandboxId) });
        }
        // Disconnected rosters are meaningless — clear both; the reconnect's immediate snapshots repaint them.
        resetPresence();
        resetAgents();
        // A restarted sandbox may have re-registered a fresh daemonUrl — pick it up before retrying. Swallowed
        // on failure for the same reason as the refresh above: the next attempt handles it.
        await refresh().catch(() => undefined);
    } finally {
        clearWatchdog();
    }
};

const loop = async (): Promise<void> => {
    while (running) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- a reconnect loop is sequential by definition
        await attempt();
        if (!running) {
            return;
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- ditto: the backoff IS the loop
        await sleep(connection.value.retryDelayMs);
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
    signalConnection({ kind: `switched`, lastKnownOnline: id !== undefined && (lastKnown.get(id) ?? false) });
    // Another sandbox runs another image — attributing the outgoing daemon's route surface to it would hide or
    // invent features on the incoming one.
    resetDaemonRoutes();
    controller?.abort();
    wake?.();
});

export function useSandboxLiveness() {
    return { start, stop };
}
