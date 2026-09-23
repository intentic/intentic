import type { LocalModelFitResponse, LocalModelPrefetch } from "@intentic/sandbox-contract";
import { computed, type ComputedRef } from "vue";
import { queryClient } from "../../lib/queryPersistence";
import { rpcKey } from "../../lib/queryKeys";
import { rpcQuery } from "../sandbox/client/rpcQuery";
import { sandboxRpc } from "../sandbox/client/sandboxRpc";
import { useSandboxQuery } from "../sandbox/client/useSandboxQuery";

// What this machine can run, read from the daemon rather than reasoned about here: a cgroup cap, a GPU that may not
// have been passed through, and weights already on disk are all facts only the sandbox holds. The connect view's local
// lane draws entirely from this.

// Only while bytes are moving. The figures change on a rebuild or a download landing, neither of which the browser is
// told about, and a page sitting open on a finished download must not keep asking.
const DOWNLOAD_POLL_MS = 1_500;

export interface LocalModelFitView {
    readonly fit: ComputedRef<LocalModelFitResponse | undefined>;
    readonly prefetch: ComputedRef<LocalModelPrefetch | undefined>;
    readonly startPrefetch: () => Promise<void>;
    readonly stopPrefetch: () => Promise<void>;
    readonly refetch: () => Promise<unknown>;
}

const setPrefetch = (answer: LocalModelPrefetch): void => {
    // The POST answers with the new state, so the lane redraws on the press rather than on the next poll.
    queryClient.setQueryData<LocalModelFitResponse>(rpcKey(`endpoints.localModelFit`), (held) =>
        held === undefined ? held : { ...held, prefetch: answer },
    );
};

const post = async (action: "start" | "stop"): Promise<void> => {
    setPrefetch(await sandboxRpc.endpoints.localModelPrefetch({ action }));
};

export const useLocalModelFit = (): LocalModelFitView => {
    const { query } = useSandboxQuery({
        ...rpcQuery(`endpoints.localModelFit`),
        refetchInterval: ({ state }) => (state.data?.prefetch.state === `downloading` ? DOWNLOAD_POLL_MS : false),
    });
    return {
        fit: computed(() => query.data.value),
        prefetch: computed(() => query.data.value?.prefetch),
        startPrefetch: () => post(`start`),
        stopPrefetch: () => post(`stop`),
        refetch: () => query.refetch(),
    };
};
