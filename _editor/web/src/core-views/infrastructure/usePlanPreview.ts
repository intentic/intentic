import { useQueryClient } from "@tanstack/vue-query";
import { errorMessage } from "@intentic/ui/async";
import { computed, ref } from "vue";
import { type PlanOrphan, type PlanStep, readPlanSteps } from "../../features/extensions/reconcileStatus";
import { useSecretKeys } from "../../features/capabilities/connect/useSecrets";
import { readIntenticLines } from "../../lib/intenticStream";
import { sandboxRequest } from "../../features/sandbox/client/sandboxClient";
import { useTerminalPanel } from "../../features/terminal/useTerminalPanel";
import { SECRETS, WORKSPACE_STATE } from "../../lib/queryKeys";
import { describeProvisionError } from "./provisionError";

// Runs `intentic deploy resolve` then `plan` in the sandbox (read+diff, nothing mutated), exposing
// per-resource create/update/remove plus orphans. Pauses before plan on missing env secrets (resolve reports
// them, plan needs them live), surfacing a checklist first. Cancellable, with a stall watchdog naming the last
// activity.

// No line for this long means the stream is dead; a healthy run narrates far more often than this.
const STALL_MS = 120_000;

export function usePlanPreview() {
    const queryClient = useQueryClient();
    const { hasKey } = useSecretKeys();
    const { openFocused } = useTerminalPanel();

    const running = ref(false);
    const ran = ref(false);
    // Any add/remove marks a preview stale, so a plan is never shown against mutated wants; starts stale.
    const stale = ref(true);
    const error = ref<string | undefined>(undefined);
    const steps = ref<PlanStep[]>([]);
    const orphans = ref<PlanOrphan[]>([]);
    // What the run is doing right now, shown instead of a blank spinner; also the detail a stall error names.
    const activity = ref<string | undefined>(undefined);
    // The env-secret keys the last resolve reported as required; the unset ones gate plan (and apply).
    const requiredEnv = ref<string[]>([]);
    const missingSecrets = computed(() => requiredEnv.value.filter((key) => !hasKey(key)));
    // resolve finished but required secrets were missing: paused before plan, waiting on the user's checklist.
    const awaitingSecrets = ref(false);

    let controller: AbortController | undefined;
    let stall: ReturnType<typeof setTimeout> | undefined;
    const armStall = (): void => {
        clearTimeout(stall);
        stall = setTimeout(() => controller?.abort(new DOMException(`preview stalled`, `TimeoutError`)), STALL_MS);
    };

    const markStale = (): void => {
        stale.value = true;
    };

    // Aborts the in-flight run; the daemon kills the CLI child on the same signal.
    const cancel = (): void => {
        controller?.abort(new DOMException(`preview cancelled`, `AbortError`));
    };

    // resolve (SSE): rewrites desired-state.json and reports required env secrets. Throws on kind:"error".
    const resolve = async (signal: AbortSignal): Promise<void> => {
        activity.value = `Resolving your configuration…`;
        const response = await sandboxRequest(`/intentic`, {
            method: `POST`,
            headers: { "content-type": `application/json` },
            body: JSON.stringify({ args: [`deploy`, `resolve`] }),
            signal,
        });
        if (!response.ok || !response.body) {
            const detail = (await response.json().catch(() => null)) as { error?: string } | null;
            throw new Error(detail?.error ?? `Resolve failed (${response.status}).`);
        }
        for await (const line of readIntenticLines(response.body)) {
            // Heartbeats only prove the daemon's tail is alive, not the CLI; arming on them would neuter the watchdog.
            if (line[`kind`] !== `heartbeat`) {
                armStall();
            }
            // The run executes visibly in a tmux session; open its tab so the user watches the actual command.
            if (line[`kind`] === `terminal` && typeof line[`session`] === `string`) {
                openFocused(line[`session`]);
            }
            if (line[`kind`] === `result` && Array.isArray(line[`envSecrets`])) {
                requiredEnv.value = line[`envSecrets`].filter((key): key is string => typeof key === `string`);
            }
            if (line[`kind`] === `error`) {
                const message = line[`message`] ?? line[`text`];
                throw new Error(typeof message === `string` ? message : `Resolve failed.`);
            }
        }
        // Refreshes the graph and secrets queries after resolve rewrote desired-state.json and named its secrets.
        await queryClient.refetchQueries({ queryKey: SECRETS.of() });
        void queryClient.invalidateQueries({ queryKey: WORKSPACE_STATE.of() });
    };

    // plan (SSE): per-resource create/update/noop verdicts plus the orphan list, narrating as it reads.
    const runPlan = async (signal: AbortSignal): Promise<void> => {
        activity.value = `Reading your live infrastructure…`;
        const response = await sandboxRequest(`/intentic`, {
            method: `POST`,
            headers: { "content-type": `application/json` },
            body: JSON.stringify({ args: [`deploy`, `plan`] }),
            signal,
        });
        if (!response.ok || !response.body) {
            const detail = (await response.json().catch(() => null)) as { error?: string } | null;
            throw new Error(detail?.error ?? `Plan failed (${response.status}).`);
        }
        const result = await readPlanSteps(response.body, (progress) => {
            armStall();
            if (progress.terminal !== undefined) {
                // The plan runs visibly in the check session; open its tab (own surfacing when resolve was skipped).
                openFocused(progress.terminal);
            } else if (progress.node !== undefined) {
                activity.value = `Checking ${progress.node}…`;
            } else if (progress.log !== undefined) {
                activity.value = progress.log;
            }
        });
        steps.value = result.steps;
        orphans.value = result.orphans;
    };

    // Shared run wrapper: fresh controller and watchdog. Cancelled runs end quietly; a tripped watchdog names
    // the last activity; everything else is humanized.
    const guarded = async (work: (signal: AbortSignal) => Promise<void>): Promise<void> => {
        if (running.value) {
            return;
        }
        running.value = true;
        error.value = undefined;
        awaitingSecrets.value = false;
        controller = new AbortController();
        armStall();
        try {
            await work(controller.signal);
        } catch (err) {
            const reason = controller.signal.aborted ? (controller.signal.reason as unknown) : err;
            if (reason instanceof DOMException && reason.name === `AbortError`) {
                return; // cancelled by the user, not an error; the preview simply stays stale.
            }
            if (reason instanceof DOMException && reason.name === `TimeoutError`) {
                error.value = `The preview stalled, last activity: ${activity.value ?? `starting`}. Cancel-and-retry, or check the sandbox.`;
                return;
            }
            error.value = describeProvisionError(errorMessage(err, `Preview failed.`));
        } finally {
            clearTimeout(stall);
            controller = undefined;
            activity.value = undefined;
            running.value = false;
        }
    };

    // The full preview: resolve, then plan unless required secrets are still missing. A missing secret pauses
    // at the checklist until continueAfterSecrets resumes.
    const run = (): Promise<void> =>
        guarded(async (signal) => {
            await resolve(signal);
            if (missingSecrets.value.length > 0) {
                awaitingSecrets.value = true;
                return;
            }
            await runPlan(signal);
            ran.value = true;
            stale.value = false;
        });

    // Resumes at plan once the checklist clears the missing secrets (a secret write invalidates the query, so
    // missingSecrets recomputes).
    const continueAfterSecrets = (): Promise<void> => {
        if (missingSecrets.value.length > 0) {
            return Promise.resolve();
        }
        return guarded(async (signal) => {
            await runPlan(signal);
            ran.value = true;
            stale.value = false;
        });
    };

    return {
        running,
        ran,
        stale,
        error,
        steps,
        orphans,
        activity,
        requiredEnv,
        missingSecrets,
        awaitingSecrets,
        markStale,
        run,
        cancel,
        continueAfterSecrets,
    };
}
