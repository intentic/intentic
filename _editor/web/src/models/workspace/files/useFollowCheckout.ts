import { WORKSPACE_FOLLOW_MAX } from "@intentic/sandbox-contract/schemas/workspace/workspace-tree";
import { onScopeDispose, watch } from "vue";
import type { ViewScope } from "../../../app/workspaceScope";
import { sandboxRpc } from "../../../client/sandbox/sandboxRpc";
import { supportsRoute } from "../../../client/sandbox/useDaemonRoutes";
import { useSandbox } from "../../../client/sandbox/useSandbox";

// Keeps a conversation's own copy of the files on screen watched by the daemon (workspace.followCheckout), so what the
// agent writes into them comes back as `checkoutChanged` while the turn runs, not only when it says it settled a call.
// A lease, renewed at half its length for as long as the surface shows the files in that copy; a surface that goes,
// changes file or copy, or loses the sandbox stops renewing and the daemon lets the folders go on its own. A daemon
// without the route, or a refused ask, costs nothing: the turn's own calls still say when a file changed (turnFacts.ts).

// The shortest gap between asks, whatever lease a daemon names; and the wait before trying again after a failed ask.
const RENEW_FLOOR_MS = 5_000;
const RETRY_MS = 15_000;

export const useFollowCheckout = (paths: () => readonly string[], scope: () => ViewScope): void => {
    const { reachable } = useSandbox();
    let timer: ReturnType<typeof setTimeout> | undefined;
    // Bumped by every stop, so an ask still out when the surface moved on schedules nothing.
    let generation = 0;
    const stop = (): void => {
        generation += 1;
        if (timer !== undefined) {
            clearTimeout(timer);
            timer = undefined;
        }
    };
    const ask = async (agent: string, wanted: string[], mine: number): Promise<void> => {
        let next = RETRY_MS;
        try {
            const { leaseMs } = await sandboxRpc.workspace.followCheckout({ agent, paths: wanted });
            next = Math.max(leaseMs / 2, RENEW_FLOOR_MS);
        } catch {
            // allow(silent-catch): following is a nicety over the calls' own news; the next tick asks again
        }
        if (mine === generation) {
            timer = setTimeout(() => void ask(agent, wanted, mine), next);
        }
    };
    watch(
        () => [scope().agent, [...new Set(paths())].slice(0, WORKSPACE_FOLLOW_MAX).join(`\n`), reachable.value, supportsRoute(`workspace.followCheckout`)] as const,
        ([agent, joined, answering, served]) => {
            stop();
            if (agent !== undefined && joined !== `` && answering && served) {
                void ask(agent, joined.split(`\n`), generation);
            }
        },
        { immediate: true },
    );
    onScopeDispose(stop);
};
