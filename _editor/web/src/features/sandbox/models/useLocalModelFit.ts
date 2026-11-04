import type { LocalModelFitResponse, LocalModelPrefetch } from "@intentic/sandbox-contract/contracts/endpoints.contract";
import { computed, type ComputedRef } from "vue";
import { queryClient } from "../../../lib/queryPersistence";
import { rpcKey } from "../../../lib/queryKeys";
import { rpcQuery } from "../../../client/sandbox/rpcQuery";
import { sandboxRpc } from "../../../client/sandbox/sandboxRpc";
import { useSandboxQuery } from "../../../client/sandbox/useSandboxQuery";

// What this machine can run, read from the daemon rather than reasoned about here: a cgroup cap, the memory free now,
// and weights already on disk are all facts only the sandbox holds. The connect view's local
// lane draws entirely from this.

// Only while bytes are moving. The figures change on a rebuild or a download landing, neither of which the browser is
// told about, and a page sitting open on a finished download must not keep asking.
const DOWNLOAD_POLL_MS = 1_500;

export interface LocalModelFitView {
    readonly fit: ComputedRef<LocalModelFitResponse | undefined>;
    readonly prefetch: ComputedRef<LocalModelPrefetch | undefined>;
    readonly stopPrefetch: () => Promise<void>;
    readonly refetch: () => Promise<unknown>;
}

const setPrefetch = (answer: LocalModelPrefetch): void => {
    // The POST answers with the new state, so the lane redraws on the press rather than on the next poll.
    queryClient.setQueryData<LocalModelFitResponse>(rpcKey(`endpoints.localModelFit`), (held) =>
        held === undefined ? held : { ...held, prefetch: answer },
    );
};

// Only ever a stop: nothing in the editor starts one (SandboxModels.vue says why), but a transfer an older editor
// began still answers to it.
const post = async (action: "stop"): Promise<void> => {
    setPrefetch(await sandboxRpc.endpoints.localModelPrefetch({ action }));
};

// Deletes a curated model's downloaded weights; the answer is the machine's fit as it now stands, so the lane redraws
// on the press. Refused by the daemon while a connection still runs on those weights.
export const deleteLocalModelWeights = async (model: string): Promise<void> => {
    queryClient.setQueryData(rpcKey(`endpoints.localModelFit`), await sandboxRpc.endpoints.localModelDelete({ model }));
};

export const useLocalModelFit = (): LocalModelFitView => {
    const { query } = useSandboxQuery({
        ...rpcQuery(`endpoints.localModelFit`),
        refetchInterval: ({ state }) => (state.data?.prefetch.state === `downloading` ? DOWNLOAD_POLL_MS : false),
    });
    return {
        fit: computed(() => query.data.value),
        prefetch: computed(() => query.data.value?.prefetch),
        stopPrefetch: () => post(`stop`),
        refetch: () => query.refetch(),
    };
};
