import type { Environment } from "@intentic/sandbox-contract/schemas/environment";
import { useQueryClient } from "@tanstack/vue-query";
import { usePollWhile } from "@intentic/ui/async";
import { computed } from "vue";
import { sandboxRaw } from "../../../../client/sandbox/sandboxRaw";
import { ENVIRONMENT_KEY, useEnvironment } from "../../../../models/sandbox/environment/useEnvironment";
import { onScreen } from "../../../../workbench/window/onScreen";

// "RESTART ONCE NO AGENT IS MID-TURN", for a checkout rebuild, as the page sees it. The rebuild holds at its swap gate and
// the sandbox lets it through (POST /environment/dev-swap-when-idle): the sandbox is what knows who is mid-turn, and it
// is still there when this page is closed or the phone holding it locks. This asks, withdraws, and reads the wait back
// off /environment, which says nothing of its own when the wait moves along, so it is asked again while one is waiting.

// How often a wait is re-read: the sandbox looks at its agents about as often.
const POLL_MS = 5_000;

export function useDevSwapWhenIdle() {
    const queryClient = useQueryClient();
    const { state, query } = useEnvironment();
    const wait = computed(() => state.value?.devSwapWhenIdle);

    usePollWhile(() => wait.value?.phase === `waiting`, {
        everyMs: POLL_MS,
        // Only a reading for the page: out of sight it waits, and the window coming back reads at once.
        visible: onScreen,
        check: async () => {
            await query.refetch();
        },
        immediate: false,
    });

    const send = async (answer: Promise<Environment>): Promise<void> => {
        queryClient.setQueryData(ENVIRONMENT_KEY, await answer);
    };
    // The device the rebuild runs on, whose gate the sandbox holds and lets through.
    const ask = (host: string): Promise<void> => send(sandboxRaw(`POST /environment/dev-swap-when-idle`, { input: { host } }));
    const withdraw = (): Promise<void> => send(sandboxRaw(`DELETE /environment/dev-swap-when-idle`));

    return { wait, ask, withdraw };
}
