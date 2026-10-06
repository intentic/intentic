import type { Environment } from "@intentic/sandbox-contract";
import { useQueryClient } from "@tanstack/vue-query";
import { usePollWhile } from "@intentic/ui/async";
import { computed } from "vue";
import { sandboxRaw } from "../../../../client/sandbox/sandboxRaw";
import { ENVIRONMENT_KEY, useEnvironment } from "../../../sandbox/environment/useEnvironment";

// "REBUILD WHEN THEY'RE IDLE", as the page sees it. The wait itself is the sandbox's (POST /environment/rebuild-when-idle),
// so a page closed or a phone locked meanwhile loses nothing; this only asks, withdraws, and reads it back off
// /environment, which says nothing on its own when the wait moves along, so it is asked again while one is under way.

// How often a wait under way is re-read: the sandbox checks its agents about as often.
const POLL_MS = 5_000;

export function useRebuildWhenIdle() {
    const queryClient = useQueryClient();
    const { state, query } = useEnvironment();
    // What the sandbox holds, if anything; absent too from one that cannot wait.
    const wait = computed(() => state.value?.rebuildWhenIdle);
    // Whether the sandbox can wait for its agents and resume what a restart cuts; an older one offers neither.
    const supported = computed(() => state.value?.waitsForAgents === true);

    // Re-read while the wait moves along; /environment says nothing of its own when it does.
    usePollWhile(() => wait.value?.phase === `waiting` || wait.value?.phase === `rebuilding`, {
        everyMs: POLL_MS,
        check: async () => {
            await query.refetch();
        },
        immediate: false,
    });

    const send = async (answer: Promise<Environment>): Promise<void> => {
        queryClient.setQueryData(ENVIRONMENT_KEY, await answer);
    };
    // The approved overlay to build, and the device that builds it.
    const ask = (host: string, hash: string): Promise<void> => send(sandboxRaw(`POST /environment/rebuild-when-idle`, { input: { host, hash } }));
    const cancel = (): Promise<void> => send(sandboxRaw(`DELETE /environment/rebuild-when-idle`));

    return { wait, supported, ask, cancel };
}
