import { useQueryClient } from "@tanstack/vue-query";
import { computed, ref } from "vue";
import { readIntenticLines } from "../../composables/intenticStream";
import { sandboxJson, sandboxRequest } from "../../composables/sandboxClient";
import { globalTerminalSource, useTerminalPanel } from "../../composables/terminal/useTerminalPanel";
import { sandboxKey } from "../../composables/useSandbox";
import { type ApplyProgressState, initialApplyState, reduceApplyLine } from "./applyProgress";
import { describeProvisionError } from "./provisionError";

/* The apply half of the infra flow: kicks off the durable apply → adopt tmux job, then surfaces structured live
 * progress by tailing the daemon's /intentic/apply/events stream (per-resource create → ready, readiness URLs,
 * convergence). Completion is EVIDENCE-based: the event log's terminal exit ({command:"adopt"}, or a failed
 * apply's) ends the run; the terminal-list poll is only the fallback for a SIGKILLed job that wrote no exit —
 * and needs two consecutive "gone" reads, so a partial terminal list can't fake completion. The tail replays
 * from the run's start (refresh rebuilds the full view), a stall watchdog catches a dead stream (the daemon
 * heartbeats every second), and a dropped stream visibly auto-reattaches instead of silently freezing.
 * Instantiated once in InfraDeclare; everything is relayed THROUGH the sandbox. */
const APPLY_SESSION = `panel-infra-apply`;
// The daemon's tail heartbeats ~1s; no line for this long = the stream is dead, reattach.
const STALL_MS = 30_000;
const REATTACH_DELAY_MS = 3_000;

export function useApplyProgress() {
    const queryClient = useQueryClient();
    const { openFocused } = useTerminalPanel();

    const state = ref<ApplyProgressState>(initialApplyState());
    // "the apply → adopt job is running" — flipped off by the event log's terminal exit (primary) or the
    // terminal poll's SIGKILL fallback.
    const applying = ref(false);
    // Failure to even start the job (the POST), kept apart from the stream-reported error the reducer records.
    const startError = ref<string | undefined>(undefined);
    // The events stream dropped and is being re-opened — progress may lag; visible, never silent.
    const reattaching = ref(false);
    let applyPoll: ReturnType<typeof setInterval> | undefined;
    // Consecutive polls that saw no running session — two in a row declare the job dead (fallback path).
    let missStreak = 0;
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
        void queryClient.invalidateQueries({ queryKey: sandboxKey(`workspace`, `state`) });
        void queryClient.invalidateQueries({ queryKey: sandboxKey(`deployments`) });
        void queryClient.invalidateQueries({ queryKey: sandboxKey(`inventory`) });
    };

    const stopWatching = (): void => {
        if (applyPoll !== undefined) {
            clearInterval(applyPoll);
            applyPoll = undefined;
        }
    };

    const finishRun = (): void => {
        stopWatching();
        attachGeneration += 1;
        reattaching.value = false;
        applying.value = false;
        refreshWorld();
    };

    // FALLBACK completion: poll the terminals list for the session being gone. Only a SIGKILLed job (no exit
    // line ever written) should end a run this way; two consecutive misses guard against a partial list read.
    const watchApply = (): void => {
        missStreak = 0;
        applyPoll ??= setInterval(async () => {
            const sessions = await globalTerminalSource.list().catch(() => undefined);
            if (sessions === undefined) {
                return; // transient list failure — the job's fate is unknown, keep polling.
            }
            if (sessions.some((session) => session.name === APPLY_SESSION && session.running)) {
                missStreak = 0;
                return;
            }
            missStreak += 1;
            if (missStreak >= 2) {
                finishRun();
            }
        }, 2500);
    };

    // Tail the durable apply events into the reduced state, replaying from the run's {kind:"start"}. The
    // terminal exit ends the run (evidence-based completion); a dropped/stalled stream visibly reattaches —
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
                    return; // a newer run took over — this loop is stale.
                }
                armStall();
                state.value = reduceApplyLine(state.value, line);
                if (state.value.jobDone) {
                    finishRun();
                    return;
                }
            }
            // Clean stream end without a terminal exit: the daemon closed on its !running() fallback (the job
            // was SIGKILLed). Let the poll confirm and finish — nothing more will be written.
        } catch {
            // Stream dropped or stalled: reattach while the run is still live — visibly, never silently.
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
            startError.value = describeProvisionError(err instanceof Error ? err.message : `Apply failed to start.`);
            applying.value = false;
            return;
        }
        openFocused(APPLY_SESSION);
        void attach();
        watchApply();
    };

    // A refresh/navigation during a run: the tmux job survived it. Recover "Applying…" from the terminals list,
    // re-attach the event stream (replays from the run's start), and resume the poll.
    const recover = async (): Promise<void> => {
        const sessions = await globalTerminalSource.list().catch(() => undefined);
        if (sessions?.some((session) => session.name === APPLY_SESSION && session.running)) {
            applying.value = true;
            attachGeneration += 1;
            void attach();
            watchApply();
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
        stopWatching,
        viewLogs: (): void => openFocused(APPLY_SESSION),
    };
}
