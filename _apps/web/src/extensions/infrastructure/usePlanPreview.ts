import { useQueryClient } from "@tanstack/vue-query";
import { computed, ref } from "vue";
import { type PlanOrphan, type PlanStep, readPlanSteps } from "../../composables/extensions/reconcileStatus";
import { useSecretKeys } from "../../composables/extensions/useSecrets";
import { readIntenticLines } from "../../composables/intenticStream";
import { sandboxRequest } from "../../composables/sandboxClient";
import { useTerminalPanel } from "../../composables/terminal/useTerminalPanel";
import { sandboxKey } from "../../composables/useSandbox";
import { describeProvisionError } from "./provisionError";

/* The pre-apply change preview: run `intentic resolve` then `intentic plan` in the sandbox (read + diff, nothing
 * mutated) and expose what the next apply WOULD do — per-resource create/update/remove + orphans — so adding a
 * want stages a reviewable pending change instead of silently deploying. Owns the missing-secrets gate lifted
 * out of InfraDeclare: resolve names the env secrets the intent requires, and any unset one pauses BEFORE plan
 * (plan reads live infra over SSH and needs them), surfacing a checklist the user fills before continuing.
 * Every run is CANCELLABLE (the abort reaches the daemon, which kills the CLI child) and watched by a stall
 * watchdog re-armed per received line — a dead stream trips it and surfaces as an error naming the last
 * activity, never as an eternal spinner. Instantiated once in InfraDeclare; everything goes THROUGH the sandbox. */

// No line for this long = the stream is dead (every operation under the CLI is deadline-bounded and plan
// narrates per node/provider, so a healthy run emits far more often).
const STALL_MS = 120_000;

export function usePlanPreview() {
    const queryClient = useQueryClient();
    const { hasKey } = useSecretKeys();
    const { openFocused } = useTerminalPanel();

    const running = ref(false);
    const ran = ref(false);
    // A preview reflects a specific inventory; any add/remove marks it stale so a plan is never shown against
    // mutated wants. Starts stale — nothing has been previewed yet.
    const stale = ref(true);
    const error = ref<string | undefined>(undefined);
    const steps = ref<PlanStep[]>([]);
    const orphans = ref<PlanOrphan[]>([]);
    // What the run is doing right now ("Checking web.production…", "orphan scan: komodo") — shown instead of a
    // blank spinner, and the detail a stall error names.
    const activity = ref<string | undefined>(undefined);
    // The env-secret keys the last resolve reported the intent REQUIRES; the unset ones gate plan (and apply).
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

    // Abort the in-flight run: the fetch body drops, and the daemon kills the CLI child on the same signal.
    const cancel = (): void => {
        controller?.abort(new DOMException(`preview cancelled`, `AbortError`));
    };

    // resolve (SSE) → rewrites desired-state.json + reports the required env secrets. Throws on a kind:"error".
    const resolve = async (signal: AbortSignal): Promise<void> => {
        activity.value = `Resolving your configuration…`;
        const response = await sandboxRequest(`/intentic`, {
            method: `POST`,
            headers: { "content-type": `application/json` },
            body: JSON.stringify({ args: [`resolve`] }),
            signal,
        });
        if (!response.ok || !response.body) {
            const detail = (await response.json().catch(() => null)) as { error?: string } | null;
            throw new Error(detail?.error ?? `Resolve failed (${response.status}).`);
        }
        for await (const line of readIntenticLines(response.body)) {
            // Heartbeats only prove the daemon's tail is alive, not the CLI — arming on them would neuter the
            // watchdog's "last activity" honesty.
            if (line[`kind`] !== `heartbeat`) {
                armStall();
            }
            // The run executes visibly in a tmux session (the stream's first frame names it) — open its tab so
            // the user watches the actual command (user-clicked → openFocused, the apply precedent).
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
        // resolve rewrote desired-state.json and named its secrets — refresh both the graph read-model and the
        // secrets query (the SSH key is written out-of-band at host-enroll, so the gate must read fresh keys).
        await queryClient.refetchQueries({ queryKey: sandboxKey(`secrets`) });
        void queryClient.invalidateQueries({ queryKey: sandboxKey(`workspace`, `state`) });
    };

    // plan (SSE) → per-resource create/update/noop verdicts + the orphan list, narrating as it reads.
    const runPlan = async (signal: AbortSignal): Promise<void> => {
        activity.value = `Reading your live infrastructure…`;
        const response = await sandboxRequest(`/intentic`, {
            method: `POST`,
            headers: { "content-type": `application/json` },
            body: JSON.stringify({ args: [`plan`] }),
            signal,
        });
        if (!response.ok || !response.body) {
            const detail = (await response.json().catch(() => null)) as { error?: string } | null;
            throw new Error(detail?.error ?? `Plan failed (${response.status}).`);
        }
        const result = await readPlanSteps(response.body, (progress) => {
            armStall();
            if (progress.terminal !== undefined) {
                // The plan runs visibly in the check session — open its tab (continueAfterSecrets runs plan
                // without a preceding resolve, so this frame is plan's own surfacing too).
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

    // Shared run wrapper: fresh controller + watchdog, cancelled runs end quietly (no error — the user chose
    // to stop), a tripped watchdog names the last activity, everything else is humanized.
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
                return; // cancelled by the user — not an error, the preview simply stays stale.
            }
            if (reason instanceof DOMException && reason.name === `TimeoutError`) {
                error.value = `The preview stalled — last activity: ${activity.value ?? `starting`}. Cancel-and-retry, or check the sandbox.`;
                return;
            }
            error.value = describeProvisionError(err instanceof Error ? err.message : `Preview failed.`);
        } finally {
            clearTimeout(stall);
            controller = undefined;
            activity.value = undefined;
            running.value = false;
        }
    };

    // The full preview: resolve, then (unless required secrets are still missing) plan. A missing secret pauses
    // at the checklist — the same gate apply uses — until continueAfterSecrets resumes at plan.
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

    // Resume at plan once the checklist cleared the missing secrets (SecretField writes invalidate the secrets
    // query, so missingSecrets recomputes reactively).
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

    return { running, ran, stale, error, steps, orphans, activity, requiredEnv, missingSecrets, awaitingSecrets, markStale, run, cancel, continueAfterSecrets };
}
