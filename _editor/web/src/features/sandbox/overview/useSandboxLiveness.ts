import { sleep } from "@intentic/base/async";
import { watch } from "vue";
import { desyncAgents } from "../../agents/fleet/useAgents";
import { reloadOnHotUpdate } from "../../../app/hotReload";
import { queryClient } from "../../../lib/queryPersistence";
import { presenceStreamOpened, resetPresence } from "../../../shell/presence/usePresence";
import { markWorkspaceChanged } from "../../workspace/changes/useWorkspaceLive";
import { classifyFailure, type ConnectionFailure, watchdogRecoveryDelay } from "../live/connection";
import { daemonErrorMessage, daemonErrorStatus, sandboxRpc, SandboxUnaddressedError } from "../client/sandboxRpc";
import { useSandboxSession } from "../client/sandboxSession";
import { acquireStreamSlot } from "../client/streamBudget";
import { applySystemEvent } from "../live/systemEvents";
import { sandboxQueryPredicate } from "../live/systemEventRouting";
import { resetDaemonBoot } from "./useDaemonBoot";
import { resetDaemonRoutes } from "./useDaemonRoutes";
import { useEndpoint } from "../secrets/useEndpoint";
import { signalConnection, useSandbox } from "../client/useSandbox";
import { uuid } from "../../../lib/uuid";

// Holds one long-lived `/events` stream to the active sandbox daemon and reconnects on failure; transition rules
// live in connection.ts, frame routing in systemEvents.ts. The stream is a typed oRPC event iterator, not
// hand-parsed SSE. Module singleton, started by the workspace shell for the session.

// No frame this long means the connection silently died; sized to tolerate a few missed heartbeats under real
// load, not just an idle one.
const WATCHDOG_MS = 10_000;

const { daemonUrl, connection, activeSandboxId, refresh } = useSandbox();
const { daemonBase, usingLocal, resolve: resolveEndpoint, demoteIfUnreachable, reset: resetEndpoint } = useEndpoint();
const { invalidateSession } = useSandboxSession();

let running = false;
let controller: AbortController | undefined;
let watchdog: ReturnType<typeof setTimeout> | undefined;
// Set when the abort came from the watchdog, not the network, so the failure classifies as a timeout rather than
// being guessed from the error.
let watchdogTripped = false;
// Backoff's controller, so a sandbox switch can cut it short instead of waiting out the full delay.
let napping: AbortController | undefined;
// Last observed reachability per sandbox id, so switching back to a recently-healthy one paints immediately while
// the stream re-establishes.
const lastKnown = new Map<string, boolean>();

const nap = (ms: number): Promise<void> => {
    napping = new AbortController();
    return sleep(ms, { signal: napping.signal });
};

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
            // The main thread stalled, not the stream; a queued frame re-arms the watchdog before this grace fires.
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

// Whether the active sandbox changed mid-attempt; its abort must not be attributed to the sandbox just switched to.
const switchedDuring = (sandboxId: string): boolean => activeSandboxId.value !== sandboxId;

// Whether the address changed mid-attempt (a promotion to loopback aborts the stream on purpose); checked before
// the demotion branch, or a promotion would read its own abort as a failure and undo itself.
const retargetedDuring = (base: string | undefined): boolean => daemonBase.value !== base;

// Consumes the stream until it ends or breaks. A clean close from the daemon still returns normally, so the
// caller treats that as its own throttled failure rather than a success.
const stream = async (sandboxId: string): Promise<void> => {
    controller = new AbortController();
    watchdogTripped = false;
    // One of six per-origin HTTP/1.1 connections for the life of the window; unbounded so it resolves immediately
    // wherever the transport multiplexes (see streamBudget.ts).
    const slot = await acquireStreamSlot(`events`, controller.signal);
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
        const frames = await sandboxRpc.system.events({ clientId }, { signal: controller.signal });
        signalConnection({ kind: `opened` });
        armWatchdog();
        // The daemon just registered this connection's blank roster entry; announce this tab's current activity.
        presenceStreamOpened(clientId);
        // Refetches the tree on every (re)connect, since a disconnect drops file-change frames; empty means refetch
        // only.
        markWorkspaceChanged([]);
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
    } finally {
        // However the attempt ended, the permit is released for the next window's stream; backoff runs without holding
        // one.
        slot();
    }
};

// One attempt from having an address to a settled outcome; how long to wait next is the connection machine's
// call (`retryDelayMs`).
const attempt = async (): Promise<void> => {
    // Needs an address to open the stream; a rejected refresh must not escape, a failure signal below covers
    // reporting it.
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
    // Checked before signalling `connect`, since reaching the try below without an address would trigger a sign-in
    // prompt over a machine that's never spoken to us. `unaddressed` already has honest wording for this case.
    if (daemonUrl.value === undefined) {
        signalConnection({
            kind: `failed`,
            failure: classifyFailure({ unaddressed: true, message: `This sandbox has never reported an address.` }),
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
        await stream(sandboxId);
        if (!running || switchedDuring(sandboxId)) {
            return;
        }
        if (retargetedDuring(base)) {
            signalConnection({ kind: `retargeted` });
            return;
        }
        // A clean close is still reported as a failure, so the machine throttles the next attempt instead of
        // hot-looping.
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
        // A dead shortcut is a repair, not an outage: retry at once instead of backing off. But a broken stream alone
        // isn't proof the address is gone, so the shortcut is re-probed here first.
        if (usingLocal.value && (await demoteIfUnreachable(sandboxId))) {
            signalConnection({ kind: `retargeted` });
            return;
        }
        const failure = failureOf(error);
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
        resetPresence();
        desyncAgents();
        // Picks up a re-registered daemonUrl before retrying; swallowed since the next attempt handles a failure here
        // too.
        await refresh().catch(() => undefined);
    } finally {
        clearWatchdog();
    }
};

// `for(;;)`, not `while(running)`: `running` is flipped by stop() from outside, so the loop condition alone
// proves nothing; the two explicit returns are where stopping takes effect.
const loop = async (): Promise<void> => {
    for (;;) {
        // oxlint-disable-next-line eslint/no-await-in-loop -- a reconnect loop is sequential by definition
        await attempt();
        if (!running) {
            return;
        }
        // oxlint-disable-next-line eslint/no-await-in-loop -- ditto: the backoff IS the loop
        await nap(connection.value.retryDelayMs);
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
    signalConnection({ kind: `switched`, lastKnownOnline: id !== undefined && (lastKnown.get(id) ?? false) });
    // Another sandbox is another image on its own clock; attributing the outgoing daemon's routes or boot state to it
    // would gate the wrong daemon's reads. Both re-report on the next hello.
    resetDaemonRoutes();
    resetDaemonBoot();
    controller?.abort();
    napping?.abort();
});

// The address changed under the open stream (promotion, demotion, or a new URL); abort so the loop reconnects on
// it now, rather than keep running on an address no longer chosen. The attempt tells this apart from a real break.
watch(daemonBase, () => {
    controller?.abort();
    napping?.abort();
});

export function useSandboxLiveness() {
    return { start, stop };
}

// One driver per window (hotReload.ts): this module is a running loop plus a `running` flag, so a hot update
// re-executing it would leave two loops or none, quietly cutting the workspace off from its daemon while it still
// looks healthy.
reloadOnHotUpdate(import.meta);
