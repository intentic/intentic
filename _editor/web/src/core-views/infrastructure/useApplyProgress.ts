import { useQueryClient } from "@tanstack/vue-query";
import { errorMessage } from "@intentic/ui/async";
import { computed, ref, watch } from "vue";
import { readIntenticLines } from "../../composables/intenticStream";
import { sandboxJson, sandboxRequest } from "../../composables/sandbox/sandboxClient";
import { listTerminals, useTerminalsQuery } from "../../composables/terminal/terminalsQuery";
import { useTerminalPanel } from "../../composables/terminal/useTerminalPanel";
import { DEPLOYMENTS, INVENTORY, WORKSPACE_STATE } from "../../composables/queryKeys";
import { type ApplyProgressState, initialApplyState, reduceApplyLine } from "./applyProgress";
import { describeProvisionError } from "./provisionError";

/* The apply half of the infra flow: kicks off the durable apply → adopt tmux job, then surfaces structured live
 * progress by tailing the daemon's /intentic/apply/events stream (per-resource create → ready, readiness URLs,
 * convergence). Completion is EVIDENCE-based: the event log's terminal exit ({command:"adopt"}, or a failed
 * apply's) ends the run; the run's tmux session going away is only the fallback for a SIGKILLed job that wrote
 * no exit, and is read as an ending only after that session was seen alive, so a list taken before the daemon
 * has listed it can't fake completion. The tail replays from the run's start (refresh rebuilds the full view),
 * a stall watchdog catches a dead stream (the daemon heartbeats while a run is idle), and a dropped stream
 * visibly auto-reattaches instead of silently freezing.
 *
 * NOTHING HERE IS ON A CLOCK. Both feeds are pushed: the daemon follows the events file with a watch and the
 * terminals list with its own `terminals` frame, so this view moves when the apply moves rather than up to a
 * poll-interval later. Instantiated once in InfraDeclare; everything is relayed THROUGH the sandbox. */
const APPLY_SESSION = `panel-infra-apply`;
// The daemon's tail heartbeats ~1s; no line for this long = the stream is dead, reattach.
const STALL_MS = 30_000;
const REATTACH_DELAY_MS = 3_000;

export function useApplyProgress() {
    const queryClient = useQueryClient();
    const { openFocused } = useTerminalPanel();

    const state = ref<ApplyProgressState>(initialApplyState());
    // "the apply → adopt job is running", flipped off by the event log's terminal exit (primary) or the
    // terminal poll's SIGKILL fallback.
    const applying = ref(false);
    // Failure to even start the job (the POST), kept apart from the stream-reported error the reducer records.
    const startError = ref<string | undefined>(undefined);
    // The events stream dropped and is being re-opened, progress may lag; visible, never silent.
    const reattaching = ref(false);
    /* Whether this run's tmux session has been SEEN alive in the shared terminals list. Absence only means
     * "finished" AFTER presence: before it, absence is the ordinary first moment of a run, the daemon has
     * launched the session and not listed it yet, and treating that as completion would end every run the
     * instant it started. Evidence, in place of the two-consecutive-misses counter a poll needed to fake it. */
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

    // Refresh the world once apply → adopt has changed it: the desired-state read-model, live deployments, and
    // the inventory (adopt syncs CI secrets that can flip a deployment live).
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

    /* FALLBACK completion: the run's tmux session going away. Only a SIGKILLed job (no exit line ever written)
     * should end a run this way, the event log's terminal exit is the primary path and gets there first.
     *
     * NOT POLLED. This reads the shared terminals list (terminalsQuery.ts), which the daemon already pushes on:
     * it watches its own tmux and sends a `terminals` frame when a pane's state changes, which is exactly and
     * only the transition being waited for here. A 2.5s timer over the tunnel used to ask the same question,
     * almost always answering "still running", for as long as an apply took.
     *
     * A transient list failure cannot fake completion: vue-query keeps the last good data through a failed
     * refetch, so `sessions` never blanks, and `sawSession` means absence is only read as an ending once there
     * was something to end. */
    const watchApply = (): void => {
        sawSession = false;
    };

    // The list itself, observed for as long as InfraDeclare is mounted, which is what makes the daemon's
    // `terminals` frame refetch it. The watcher is scope-bound, so it retires with the view and there is
    // nothing to stop by hand.
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

    // Tail the durable apply events into the reduced state, replaying from the run's {kind:"start"}. The
    // terminal exit ends the run (evidence-based completion); a dropped/stalled stream visibly reattaches,
    // safe, because the log is durable and the reducer resets on the replayed start marker.
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
            // Clean stream end without a terminal exit: the daemon closed on its !running() fallback (the job
            // was SIGKILLed). Let the poll confirm and finish, nothing more will be written.
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

    // Start apply → adopt (a no-op daemon-side while one runs), hand the user its terminal tab, then follow both
    // the structured event stream (progress + completion) and the fallback terminal poll.
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

    /* A refresh/navigation during a run: the tmux job survived it. Recover "Applying…" from the terminals list,
     * re-attach the event stream (replays from the run's start), and resume watching.
     *
     * Reads the shared list rather than the reactive one above: on mount that query may not have answered yet,
     * and "no data yet" must not be read as "no run in progress". Seeing the session HERE is also what arms
     * `sawSession`, so a job SIGKILLed after this point still ends the run. */
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
