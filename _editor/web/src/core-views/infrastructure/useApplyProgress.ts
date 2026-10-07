import { useQueryClient } from "@tanstack/vue-query";
import { messageOr } from "@intentic/ui/async";
import { t } from "@intentic/ui/i18n";
import { anySignal, Latest, sleep } from "@intentic/base/async";
import { computed, onScopeDispose, ref, watch } from "vue";
import { readIntenticLines } from "../../lib/intenticStream";
import { SandboxHttpError } from "../../client/sandbox/sandboxHttpError";
import { sandboxRpc } from "../../client/sandbox/sandboxRpc";
import { listTerminals, useTerminalsQuery } from "../../features/terminal/terminalsQuery";
import { useTerminalPanel } from "../../features/terminal/useTerminalPanel";
import { DEPLOYMENTS, rpcKey, WORKSPACE_STATE } from "../../lib/queryKeys";
import { type ApplyProgressState, initialApplyState, reduceApplyLine } from "./applyProgress";
import { describeProvisionError } from "./provisionError";

// Kicks off the apply→adopt tmux job and tails /intentic/apply/events for live progress. Completion is
// evidence-based: the event log's terminal exit ends the run; the tmux session vanishing is only the SIGKILL
// fallback, read as an ending only once seen alive. Nothing here polls; a stalled stream visibly reattaches instead of
// freezing.
const APPLY_SESSION = `panel-infra-apply`;
// The daemon's tail heartbeats ~1s; no line for this long means the stream is dead, reattach.
const STALL_MS = 30_000;
const REATTACH_DELAY_MS = 3_000;

export function useApplyProgress() {
    const queryClient = useQueryClient();
    const { openFocused } = useTerminalPanel();

    const state = ref<ApplyProgressState>(initialApplyState());
    // "apply→adopt is running", flipped off by the event log's exit or the poll's SIGKILL fallback.
    const applying = ref(false);
    // Failure to even start the job (the POST), kept apart from the stream-reported error the reducer records.
    const startError = ref<string | undefined>(undefined);
    // The events stream dropped and is being re-opened; progress may lag, but visibly, never silently.
    const reattaching = ref(false);
    // Whether this run's tmux session was seen alive; absence reads as "finished" only after presence.
    let sawSession = false;
    // The events stream of the run being followed. The run ending, a newer run, or the view going away aborts it at once,
    // its fetch and its reattach wait with it, rather than on whatever line it happened to read next.
    const following = new Latest();
    onScopeDispose(() => following.dispose());

    const error = computed(() => startError.value ?? state.value.error);
    const nodes = computed(() => [...state.value.nodes.values()]);
    const readiness = computed(() => [...state.value.readiness.values()]);
    const iterations = computed(() => state.value.iterations);
    const prunes = computed(() => state.value.prunes);
    const orphans = computed(() => state.value.orphans);
    const converged = computed(() => state.value.converged);
    const applyPhaseDone = computed(() => state.value.applyPhaseDone);
    const doneCount = computed(() => nodes.value.filter((node) => node.state === `done`).length);
    const progressPct = computed(() => (nodes.value.length === 0 ? 0 : Math.round((doneCount.value / nodes.value.length) * 100)));

    // Refreshes the world once apply→adopt has changed it: desired-state, live deployments, and inventory
    // (adopt syncs CI secrets that can flip a deployment live).
    const refreshWorld = (): void => {
        void queryClient.invalidateQueries({ queryKey: WORKSPACE_STATE.of() });
        void queryClient.invalidateQueries({ queryKey: DEPLOYMENTS.of() });
        void queryClient.invalidateQueries({ queryKey: rpcKey(`inventory.list`) });
    };

    const finishRun = (): void => {
        sawSession = false;
        following.abort();
        reattaching.value = false;
        applying.value = false;
        refreshWorld();
    };

    // Fallback completion via the tmux session vanishing: only a SIGKILLed job (no exit line) ends a run this
    // way. Reads the pushed terminals list, never polls; vue-query keeps stale data so a failed refetch can't fake
    // completion.
    const watchApply = (): void => {
        sawSession = false;
    };

    // Observed while InfraDeclare is mounted; scope-bound, so it retires with the view, nothing to stop by hand.
    const { sessions } = useTerminalsQuery();
    watch(sessions, (list) => {
        if (!applying.value) {
            return;
        }
        if (list.some((session) => session.name === APPLY_SESSION && session.running)) {
            sawSession = true;
            return;
        }
        if (sawSession) {
            finishRun();
        }
    });

    // Tails the durable apply events into reduced state, replaying from {kind:"start"}. The terminal exit ends
    // the run; a dropped/stalled stream visibly reattaches, safe since the log is durable and the reducer resets on
    // replay.
    const attach = async (run: AbortSignal): Promise<void> => {
        const stalled = new AbortController();
        let stall: ReturnType<typeof setTimeout> | undefined;
        const armStall = (): void => {
            clearTimeout(stall);
            stall = setTimeout(() => stalled.abort(new DOMException(`events stream stalled`, `TimeoutError`)), STALL_MS);
        };
        try {
            const lines = await sandboxRpc.intentic.applyEvents(undefined, { signal: anySignal(run, stalled.signal) }).catch((failure: unknown) => {
                throw failure instanceof SandboxHttpError ? new Error(`events stream unavailable (${failure.status})`) : failure;
            });
            reattaching.value = false;
            armStall();
            for await (const line of readIntenticLines(lines)) {
                // A line already read when the run was let go of speaks for nobody.
                if (run.aborted) {
                    return;
                }
                armStall();
                state.value = reduceApplyLine(state.value, line);
                if (state.value.jobDone) {
                    finishRun();
                    return;
                }
            }
            // Clean stream end without a terminal exit: the job was SIGKILLed. Let the poll confirm and finish.
        } catch {
            // Stream dropped or stalled: reattach while the run is still live, visibly, never silently.
            clearTimeout(stall);
            if (run.aborted || !applying.value) {
                return;
            }
            reattaching.value = true;
            await sleep(REATTACH_DELAY_MS, { signal: run });
            if (!run.aborted && applying.value) {
                void attach(run);
            }
        } finally {
            clearTimeout(stall);
        }
    };

    // Starts apply→adopt (a no-op daemon-side while one runs), opens the user's terminal tab, then follows both
    // the structured event stream and the fallback terminal poll.
    const launch = async (): Promise<void> => {
        if (applying.value) {
            return;
        }
        state.value = initialApplyState();
        startError.value = undefined;
        applying.value = true;
        const run = following.next();
        try {
            await sandboxRpc.intentic.apply();
        } catch (err) {
            startError.value = describeProvisionError(messageOr(err, t(`views.applyProgress.applyFailedToStart`)));
            applying.value = false;
            return;
        }
        openFocused(APPLY_SESSION);
        void attach(run);
        watchApply();
    };

    // A refresh/navigation during a run: the tmux job survived it. Recovers "Applying…" from the terminals list,
    // re-attaches the event stream, and arms `sawSession` so a later SIGKILL still ends the run.
    const recover = async (): Promise<void> => {
        const listed = await listTerminals().catch((failure: unknown) => {
            console.warn(`infrastructure: couldn't check for an apply still running`, failure);
            return undefined;
        });
        if (listed?.some((session) => session.name === APPLY_SESSION && session.running)) {
            applying.value = true;
            void attach(following.next());
            watchApply();
            sawSession = true;
        }
    };

    return {
        applying,
        reattaching,
        error,
        nodes,
        readiness,
        iterations,
        prunes,
        orphans,
        converged,
        applyPhaseDone,
        progressPct,
        launch,
        recover,
        viewLogs: (): void => openFocused(APPLY_SESSION),
    };
}
