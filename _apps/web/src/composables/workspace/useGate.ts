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

// Module scope because it closes over nothing: the query key is the same for every caller (there is one gate).
const invalidate = (): void => void queryClient.invalidateQueries({ queryKey: sandboxKey(`gate`, `verdict`) });

export function useGate() {
    const { query, error } = useSandboxQuery<GateVerdict>({
        queryKey: sandboxKey(`gate`, `verdict`),
        queryFn: () => sandboxJson<GateVerdict>(`/gate/verdict`),
        // The return type is annotated because the closure reads `query`, which it is part of initializing —
        // without it TS has to infer the whole options object through this body and gives up (TS7022).
        refetchInterval: (): number => {
            const current = query.data.value;
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
        run: () => act(`/gate/run`, `Could not start the checks.`),
        cancel: () => act(`/gate/cancel`, `Could not stop the checks.`),
        fix: () => act(`/gate/fix`, `Could not start the fix.`),
    };
}
