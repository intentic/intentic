import { anySignal, Latest, sleep, TimeoutError } from "@intentic/base/async";
import { watch } from "vue";
import { desyncAgents } from "../../agents/fleet/useAgents";
import { reloadOnHotUpdate } from "../../../app/hotReload";
import { queryClient } from "../../../lib/queryPersistence";
import { clearPresence, presenceStreamOpened } from "../../../workbench/presence/usePresence";
import { classifyFailure, type ConnectionFailure, watchdogRecoveryDelay } from "../../../client/sandbox/connection";
import { forgetEdgeVerdict, lastEdgeVerdict } from "../../../client/sandbox/edgeVerdict";
import { SandboxUnaddressedError } from "../../../client/sandbox/sandboxAuthFetch";
import { daemonErrorMessage, daemonErrorStatus, sandboxRpc } from "../../../client/sandbox/sandboxRpc";
import { useSandboxSession } from "../../../client/session/sandboxSession";
import { acquireStreamSlot } from "../../../lib/streamBudget";
import { watchPageWake } from "../../../client/sandbox/pageWake";
import { applySystemEvent } from "../live/systemEvents";
import { sandboxQueryPredicate } from "../live/systemEventRouting";
import { useEndpoint } from "../../../client/endpoint/useEndpoint";
import { signalConnection, useSandbox } from "../../../client/sandbox/useSandbox";
import { uuid } from "../../../lib/uuid";
import { sandboxSeemsAlive, startDiagnosis, stopDiagnosis } from "../diagnosis/useDiagnosis";
import { t } from "@intentic/ui/i18n";

// Holds one long-lived `/events` stream to the active sandbox daemon and reconnects on failure; transition rules
// live in connection.ts, frame routing in systemEvents.ts. The stream is a typed oRPC event iterator, not
// hand-parsed SSE. Module singleton, started by the workspace shell for the session.

// No frame this long means the connection silently died; sized to tolerate a few missed heartbeats under real
// load, not just an idle one.
const WATCHDOG_MS = 10_000;
// The daemon's heartbeat is produced on its own event loop, so a sandbox the diagnosis saw alive but slow (its netd
// answering for it, diagnosis/) would trip the ordinary watchdog on every attempt, and each reconnect adds load it has
// to work through before its first frame. While that holds, a stream is given this long, and a retry waits this long.
const BUSY_WATCHDOG_MS = 30_000;
const BUSY_RETRY_MS = 10_000;

const watchdogMs = (): number => (sandboxSeemsAlive() ? BUSY_WATCHDOG_MS : WATCHDOG_MS);

const { daemonUrl, connection, activeSandboxId, refresh } = useSandbox();
const { daemonBase, usingLocal, resolve: resolveEndpoint, demoteIfUnreachable, reset: resetEndpoint, recheckAfterWake } = useEndpoint();
const { invalidateSession } = useSandboxSession();

// From start() to stop(). Each run is its own signal, so a stop ends the stream and the backoff at once, and a loop on
// its way out after a stop() cannot carry on beside the one a start() right after it began.
const runs = new Latest();
// One attempt and the backoff after it. A switch or a retarget aborts it, so the loop reconnects now rather than once
// the stream notices or the backoff runs out.
const attempts = new Latest();
// Last observed reachability per sandbox id, so switching back to a recently-healthy one paints immediately while
// the stream re-establishes.
const lastKnown = new Map<string, boolean>();

const failureOf = (error: unknown): ConnectionFailure => {
    if (error instanceof SandboxUnaddressedError) {
        return classifyFailure({ unaddressed: true, message: error.message });
    }
    // Read for every arm below, not just the last: a watchdog trip on a box whose tunnel the edge says is gone is a
    // detached sandbox, not a slow one.
    const edge = lastEdgeVerdict(activeSandboxId.value);
    // The watchdog's own cut (stream() below), not a guess from what the transport threw when it was cut.
    if (error instanceof TimeoutError) {
        return classifyFailure({ watchdog: true, edge, message: t(`sandbox.useSandboxLiveness.sandboxStoppedResponding`) });
    }
    return classifyFailure({ status: daemonErrorStatus(error), edge, message: daemonErrorMessage(error) });
};

// Whether the active sandbox changed mid-attempt; its abort must not be attributed to the sandbox just switched to.
const switchedDuring = (sandboxId: string): boolean => activeSandboxId.value !== sandboxId;

// Whether the address changed mid-attempt (a promotion to loopback aborts the stream on purpose); checked before
// the demotion branch, or a promotion would read its own abort as a failure and undo itself.
const retargetedDuring = (base: string | undefined): boolean => daemonBase.value !== base;

// Whether the attempt's outcome stopped being its own to report while it waited: a stop and a switch announce
// themselves; a retarget is announced here, since only the attempt knows the address it was bound to. An attempt aborted
// for one of them reports nothing even when the change has since been undone, and the next one starts at once.
const superseded = (signal: AbortSignal, run: AbortSignal, sandboxId: string, base: string | undefined): boolean => {
    if (run.aborted || switchedDuring(sandboxId)) {
        return true;
    }
    if (retargetedDuring(base)) {
        signalConnection({ kind: `retargeted` });
        return true;
    }
    return signal.aborted;
};

// Consumes the stream until it ends or breaks. A clean close from the daemon still returns normally, so the
// caller treats that as its own throttled failure rather than a success. A stream the watchdog cut throws its
// TimeoutError however it ended, so the failure classifies as a timeout rather than being guessed from the error.
const stream = async (sandboxId: string, signal: AbortSignal): Promise<void> => {
    // The watchdog's own controller under the attempt's, and its timer this stream's alone: it cannot fire into the
    // failure handling after the stream, nor be mistaken for a stop or a switch.
    const silence = new AbortController();
    const cut = anySignal(signal, silence.signal);
    let watchdog: ReturnType<typeof setTimeout> | undefined;
    const armWatchdog = (delayMs = watchdogMs()): void => {
        clearTimeout(watchdog);
        const dueAt = performance.now() + delayMs;
        watchdog = setTimeout(() => {
            const recoveryDelay = watchdogRecoveryDelay(performance.now() - dueAt);
            if (recoveryDelay > 0) {
                // The main thread stalled, not the stream; a queued frame re-arms the watchdog before this grace fires.
                armWatchdog(recoveryDelay);
                return;
            }
            silence.abort(new TimeoutError(`the event stream went silent`));
        }, delayMs);
    };
    // One of six per-origin HTTP/1.1 connections for the life of the window; unbounded so it resolves immediately
    // wherever the transport multiplexes (see streamBudget.ts).
    const slot = await acquireStreamSlot(`events`, cut);
    if (slot === undefined) {
        return;
    }
    try {
        // Armed before the connect too, so a hung connect (a dead tunnel) trips it instead of leaving the optimistic
        // paint up.
        armWatchdog();
        // Per-connection, never reused, so a lingering old connection's teardown can only remove its own presence
        // entry.
        const clientId = uuid();
        const frames = await sandboxRpc.system.events({ clientId }, { signal: cut });
        signalConnection({ kind: `opened` });
        armWatchdog();
        // The daemon just registered this connection's blank roster entry; announce this tab's current activity.
        presenceStreamOpened(clientId);
        for await (const frame of frames) {
            // Stamps, not just counts, each run of frames so a later break can be told from a daemon that never holds a
            // stream up (connection.ts); only the first frame of a run matters.
            signalConnection({ kind: `frame`, at: Date.now() });
            armWatchdog();
            // Re-checked every heartbeat, not just per connect: a long-lived stream gets no other chance to notice a
            // better route.
            void resolveEndpoint().catch(() => undefined);
            applySystemEvent(frame, sandboxId);
        }
        silence.signal.throwIfAborted();
    } catch (error) {
        throw silence.signal.aborted ? silence.signal.reason : error;
    } finally {
        clearTimeout(watchdog);
        // Release the stream permit after every attempt, including backoff.
        slot();
    }
};

// A break that is this attempt's own to report: classified, and what it leaves stale cleared before the next attempt.
const reportBreak = async (failure: ConnectionFailure, sandboxId: string): Promise<void> => {
    signalConnection({ kind: `failed`, failure, at: Date.now() });
    if (failure.kind === `unauthenticated`) {
        // Bearer rejected (rotated or expired secret); drop the session so the retry re-authenticates instead of
        // replaying it.
        invalidateSession();
    }
    if (failure.kind === `forbidden`) {
        // A revoked member must not keep a cached (persisted) copy of the sandbox on disk.
        queryClient.removeQueries({ predicate: sandboxQueryPredicate(sandboxId) });
    }
    // Presence is meaningless while disconnected, so it clears outright. The roster only desyncs (its guard
    // resets), so the painted list stays until the reconnect's snapshot overwrites it.
    clearPresence();
    desyncAgents();
    // Picks up a re-registered daemonUrl before retrying; swallowed since the next attempt handles a failure here
    // too.
    await refresh().catch(() => undefined);
};

// One attempt from having an address to a settled outcome; how long to wait next is the connection machine's
// call (`retryDelayMs`). `run` is the loop's, `signal` this attempt's under it.
const attempt = async (signal: AbortSignal, run: AbortSignal): Promise<void> => {
    // Needs an address to open the stream; a rejected refresh must not escape, a failure signal below covers
    // reporting it.
    if (daemonUrl.value === undefined) {
        await refresh().catch(() => undefined);
        // Stopped or switched while it asked: nothing to report, and nothing to open after a stop.
        if (signal.aborted) {
            return;
        }
    }
    const sandboxId = activeSandboxId.value;
    if (sandboxId === undefined) {
        signalConnection({
            kind: `failed`,
            failure: classifyFailure({ unaddressed: true, message: t(`sandbox.useSandboxLiveness.noSandboxSelected`) }),
            at: Date.now(),
        });
        return;
    }
    // Checked before signalling `connect`, since reaching the try below without an address would trigger a sign-in
    // prompt over a machine that's never spoken to us. `unaddressed` already has honest wording for this case.
    if (daemonUrl.value === undefined) {
        signalConnection({
            kind: `failed`,
            failure: classifyFailure({ unaddressed: true, message: t(`sandbox.useSandboxLiveness.sandboxNeverReportedAddress`) }),
            at: Date.now(),
        });
        return;
    }
    // Qualifies the fastest address in the background, never awaited, so a hung probe can't delay the connect; a
    // mid-stream qualification retargets via the watch below.
    void resolveEndpoint().catch(() => undefined);
    // Address this attempt is bound to, so its own deliberate abort can be told from a real break.
    const base = daemonBase.value;
    signalConnection({ kind: `connect` });
    try {
        await stream(sandboxId, signal);
        if (superseded(signal, run, sandboxId, base)) {
            return;
        }
        // A clean close is still reported as a failure, so the machine throttles the next attempt instead of
        // hot-looping.
        signalConnection({
            kind: `failed`,
            failure: classifyFailure({
                closed: true,
                edge: lastEdgeVerdict(sandboxId),
                message: t(`sandbox.useSandboxLiveness.sandboxClosedConnection`),
            }),
            at: Date.now(),
        });
    } catch (error) {
        if (superseded(signal, run, sandboxId, base)) {
            return;
        }
        // A dead shortcut is a repair, not an outage: retry at once instead of backing off. But a broken stream alone
        // isn't proof the address is gone, so the shortcut is re-probed here first.
        if (usingLocal.value) {
            const demoted = await demoteIfUnreachable(sandboxId);
            // The probe takes a while: a stop, switch or retarget inside it is not this box's failure to report, least
            // of all against the box switched to.
            if (superseded(signal, run, sandboxId, base)) {
                return;
            }
            if (demoted) {
                signalConnection({ kind: `retargeted` });
                return;
            }
        }
        await reportBreak(failureOf(error), sandboxId);
    }
};

// An attempt and its backoff share one signal: a switch or a retarget ends both, so the next attempt starts at once,
// and a stop ends the run wherever it is, the backoff included.
const loop = async (run: AbortSignal): Promise<void> => {
    while (!run.aborted) {
        const signal = attempts.next(run);
        // oxlint-disable-next-line eslint/no-await-in-loop -- a reconnect loop is sequential by definition
        await attempt(signal, run);
        // oxlint-disable-next-line eslint/no-await-in-loop -- ditto: the backoff IS the loop
        await sleep(sandboxSeemsAlive() ? Math.max(connection.value.retryDelayMs, BUSY_RETRY_MS) : connection.value.retryDelayMs, { signal });
    }
};

// Set while running: a page that slept re-checks its loopback address before calls queue on it (useEndpoint.ts).
let unwatchWake: (() => void) | undefined;

const start = (): void => {
    if (runs.current !== undefined) {
        return;
    }
    const run = runs.next();
    unwatchWake = watchPageWake(recheckAfterWake);
    startDiagnosis();
    void loop(run);
};

const stop = (): void => {
    runs.abort();
    stopDiagnosis();
    unwatchWake?.();
    unwatchWake = undefined;
    signalConnection({ kind: `disconnect` });
};

// Re-probes the moment the active sandbox changes: records the outgoing sandbox's state, primes the machine with
// the incoming one's last known state, and aborts so the loop reconnects immediately.
watch(activeSandboxId, (id, previous) => {
    if (previous !== undefined) {
        lastKnown.set(previous, connection.value.phase === `online`);
    }
    // Switching away and back is the user's own retry for a shortcut demoted earlier this session.
    if (id !== undefined) {
        resetEndpoint(id);
    }
    // The outgoing box's verdict must never be read as the incoming one's.
    forgetEdgeVerdict();
    signalConnection({ kind: `switched`, lastKnownOnline: id !== undefined && (lastKnown.get(id) ?? false) });
    attempts.abort();
});

// The address changed under the open stream (promotion, demotion, or a new URL); abort so the loop reconnects on
// it now, rather than keep running on an address no longer chosen. The attempt tells this apart from a real break.
watch(daemonBase, () => attempts.abort());

export function useSandboxLiveness() {
    return { start, stop };
}

// One driver per window (hotReload.ts): this module is a running loop plus a `running` flag, so a hot update
// re-executing it would leave two loops or none, quietly cutting the workspace off from its daemon while it still
// looks healthy.
reloadOnHotUpdate(import.meta);
