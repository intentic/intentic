import type { GateVerdict } from "@intentic/sandbox-contract";
import { computed } from "vue";
import { queryClient } from "../queryPersistence";
import { sandboxJson } from "../sandbox/sandboxClient";
import { sandboxKey } from "../sandbox/useSandbox";
import { useSandboxQuery } from "../sandbox/useSandboxQuery";
import { errorMessage } from "../useAsyncAction";

/* THE LANDING GATE'S VERDICT — the daemon's answer to "would this push go red", read by the Changes panel.
 *
 * The gate runs the workspace's own check command over the composite of every agent's landed work, once the
 * fleet goes quiet and before the user starts staging (the daemon's gate/gate.ts explains why that moment and
 * not one of the four others). Everything here is a read plus two buttons: the daemon owns the debounce, the
 * child process and the fix turn, because all three have to outlive any browser that is watching.
 *
 * POLLED, not pushed. A verdict changes a handful of times per landing burst, and the panel is already polling
 * /git/changes beside it — a dedicated event channel for a badge would be more machinery than the badge is
 * worth. The interval is short while something is in flight (the badge is a progress indicator then) and long
 * once it settles, which is the same shape usePipelines uses for the same reason. */

const SETTLED_POLL_MS = 15_000;
const ACTIVE_POLL_MS = 2_000;

const IDLE: GateVerdict = { status: `idle`, command: ``, output: ``, fingerprint: ``, stale: false, implicated: [] };

/* THE GATE'S OBJECTION TO PUSHING RIGHT NOW — one sentence, or undefined when it has none.
 *
 * The habit this exists for: land, commit, push, all inside a minute — routinely inside the gate's own quiet
 * period, so the push is the LAST moment anything can be said before CI says it. A guardrail and not a block:
 * it states what is wrong in the verdict's own words and leaves the push one click away, because a check the
 * user has already judged (a known-flaky suite, a failure they are pushing a fix for) is not grounds to stop
 * them — and a gate that stopped them would be uninstalled by the end of the week.
 *
 * Silent on exactly two states: the gate switched off (no command ⇒ it has no opinion to offer, and inventing
 * one would make configuring a command feel like a trap) and a pass that still describes the tree in hand.
 * Everything else earns a sentence — never ran, queued, mid-run, cancelled, errored, failed, or passed against
 * a tree that has since moved. `stale` is only consulted for a pass because it is only a pass whose meaning it
 * reverses; a stale failure is still a failure worth hearing about.
 */
export const pushObjection = (verdict: GateVerdict): string | undefined => {
    if (verdict.command === ``) {
        return undefined;
    }
    switch (verdict.status) {
        case `idle`:
            return `\`${verdict.command}\` has not run on this work yet.`;
        case `armed`:
            return `\`${verdict.command}\` is queued but has not started yet.`;
        case `running`:
            return `\`${verdict.command}\` is still running.`;
        case `failed`:
            return verdict.timedOut === true
                ? `\`${verdict.command}\` never finished — it hit the time limit and was killed.`
                : `\`${verdict.command}\` failed.`;
        case `cancelled`:
            return `\`${verdict.command}\` was stopped before it finished.`;
        case `error`:
            return `\`${verdict.command}\` could not run at all.`;
        case `passed`:
            return verdict.stale ? `\`${verdict.command}\` passed, but the workspace has changed since it ran.` : undefined;
    }
};

// Module scope because it closes over nothing: the query key is the same for every caller (there is one gate).
const invalidate = (): void => void queryClient.invalidateQueries({ queryKey: sandboxKey(`gate`, `verdict`) });

export function useGate() {
    const { query, error } = useSandboxQuery<GateVerdict>({
        queryKey: sandboxKey(`gate`, `verdict`),
        queryFn: () => sandboxJson<GateVerdict>(`/gate/verdict`),
        // The interval reads the query vue-query HANDS the callback, never the `query` this destructuring is
        // still initializing: the observer computes its timers synchronously inside useQuery, so closing over
        // the outer const throws "Cannot access 'query' before initialization" and takes the whole Changes
        // panel down with it. Same shape as useVpn/usePanels, for the same reason.
        refetchInterval: (state) => {
            const current = state.state.data;
            return current?.status === `running` || current?.status === `armed` || current?.fix?.outcome === `running`
                ? ACTIVE_POLL_MS
                : SETTLED_POLL_MS;
        },
    });

    const verdict = computed(() => query.data.value ?? IDLE);

    // Every action is fire-and-acknowledge: the suite and the fix turn both outlive the request, so the daemon
    // answers `ok` and the poll above is what follows the work. Invalidating on success is what makes the badge
    // react to the click rather than at the end of the current interval.
    const act = async (path: string, failed: string): Promise<string | undefined> => {
        try {
            await sandboxJson(path, { method: `POST` });
            invalidate();
            return undefined;
        } catch (cause) {
            return errorMessage(cause, failed);
        }
    };

    return {
        verdict,
        error,
        // `off` and not just "idle": with no command configured there is nothing for the panel to draw, and the
        // badge has to disappear rather than sit there saying it has no opinion.
        off: computed(() => verdict.value.command === ``),
        busy: computed(() => verdict.value.status === `running` || verdict.value.fix?.outcome === `running`),
        // What the panel puts in front of a push it is not happy about. Undefined ⇒ push without asking.
        pushObjection: computed(() => pushObjection(verdict.value)),
        run: () => act(`/gate/run`, `Could not start the checks.`),
        cancel: () => act(`/gate/cancel`, `Could not stop the checks.`),
        fix: () => act(`/gate/fix`, `Could not start the fix.`),
    };
}
