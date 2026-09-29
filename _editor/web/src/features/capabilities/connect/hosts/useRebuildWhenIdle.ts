import { EnvironmentSchema } from "@intentic/api-contract";
import { useQueryClient } from "@tanstack/vue-query";
import { computed, onBeforeUnmount, watch } from "vue";
import { jsonBody } from "../../../sandbox/client/jsonBody";
import { sandboxJson } from "../../../sandbox/client/sandboxClient";
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

    let poll: ReturnType<typeof setInterval> | undefined;
    watch(
        () => wait.value?.phase,
        (phase) => {
            clearInterval(poll);
            poll = phase === `waiting` || phase === `rebuilding` ? setInterval(() => void query.refetch(), POLL_MS) : undefined;
        },
        { immediate: true },
    );
    onBeforeUnmount(() => clearInterval(poll));

    const send = async (init: RequestInit): Promise<void> => {
        queryClient.setQueryData(ENVIRONMENT_KEY, EnvironmentSchema.parse(await sandboxJson(`/environment/rebuild-when-idle`, init)));
    };
    // The approved overlay to build, and the device that builds it.
    const ask = (host: string, hash: string): Promise<void> => send(jsonBody(`POST`, { host, hash }));
    const cancel = (): Promise<void> => send({ method: `DELETE` });

    return { wait, supported, ask, cancel };
}
