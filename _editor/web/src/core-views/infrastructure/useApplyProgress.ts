import { useQueryClient } from "@tanstack/vue-query";
import { errorMessage } from "@intentic/ui/async";
import { computed, ref, watch } from "vue";
import { readIntenticLines } from "../../lib/intenticStream";
import { sandboxJson, sandboxRequest } from "../../features/sandbox/client/sandboxClient";
import { listTerminals, useTerminalsQuery } from "../../features/terminal/terminalsQuery";
import { useTerminalPanel } from "../../features/terminal/useTerminalPanel";
import { DEPLOYMENTS, INVENTORY, WORKSPACE_STATE } from "../../lib/queryKeys";
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
    // Invalidates stale attach loops after the run they belonged to ended.
    let attachGeneration = 0;

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
        void queryClient.invalidateQueries({ queryKey: INVENTORY.of() });
    };

    const finishRun = (): void => {
        sawSession = false;
        attachGeneration += 1;
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
    const attach = async (): Promise<void> => {
        const generation = attachGeneration;
        const controller = new AbortController();
        let stall: ReturnType<typeof setTimeout> | undefined;
        const armStall = (): void => {
            clearTimeout(stall);
            stall = setTimeout(() => controller.abort(new DOMException(`events stream stalled`, `TimeoutError`)), STALL_MS);
        };
        try {
            const response = await sandboxRequest(`/intentic/apply/events`, { method: `GET`, signal: controller.signal });
            if (!response.ok || !response.body) {
                throw new Error(`events stream unavailable (${response.status})`);
            }
            reattaching.value = false;
            armStall();
            for await (const line of readIntenticLines(response.body)) {
                if (generation !== attachGeneration) {
                    controller.abort();
                    return; // a newer run took over: this loop is stale.
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
            if (generation === attachGeneration && applying.value) {
                reattaching.value = true;
                setTimeout(() => {
                    if (generation === attachGeneration && applying.value) {
                        void attach();
                    }
                }, REATTACH_DELAY_MS);
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
        attachGeneration += 1;
        try {
            await sandboxJson(`/intentic/apply`, { method: `POST` });
        } catch (err) {
            startError.value = describeProvisionError(errorMessage(err, `Apply failed to start.`));
            applying.value = false;
            return;
        }
        openFocused(APPLY_SESSION);
        void attach();
        watchApply();
    };

    // A refresh/navigation during a run: the tmux job survived it. Recovers "Applying…" from the terminals list,
    // re-attaches the event stream, and arms `sawSession` so a later SIGKILL still ends the run.
    const recover = async (): Promise<void> => {
        const listed = await listTerminals().catch(() => undefined);
        if (listed?.some((session) => session.name === APPLY_SESSION && session.running)) {
            applying.value = true;
            attachGeneration += 1;
            void attach();
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
