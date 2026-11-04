import type { SealHouse, SealMode } from "@intentic/sandbox-contract/schemas/seal";
import { computed, type ComputedRef, effectScope } from "vue";
import { rpcQuery } from "../../../client/sandbox/rpcQuery";
import { sandboxRpc } from "../../../client/sandbox/sandboxRpc";
import { supportsRoute } from "../../../client/sandbox/useDaemonRoutes";
import { useSandboxQuery } from "../../../client/sandbox/useSandboxQuery";
import { rpcKey } from "../../../lib/queryKeys";
import { queryClient } from "../../../lib/queryPersistence";

// WHO READS WHOSE CONVERSATIONS IN THIS SANDBOX (GET /seal): the house rule, whether an organisation fixed it, and what a
// conversation the reader starts now begins as. One read for the whole app, made once in a scope of its own, since the
// composer's pill, the chat's head, Access ▸ People and Settings all ask it, some from plain functions. A daemon from
// before private conversations has no such route: nothing is asked of it, and every surface reads that as no house rule.

interface HouseRead {
    readonly house: ComputedRef<SealHouse | undefined>;
    readonly loaded: ComputedRef<boolean>;
}

let read: HouseRead | undefined;

const houseRead = (): HouseRead => {
    read ??= effectScope(true).run((): HouseRead => {
        const { query } = useSandboxQuery<SealHouse>({ ...rpcQuery(`seal.house`), enabled: computed(() => supportsRoute(`seal.house`)) });
        return {
            house: computed(() => query.data.value),
            loaded: computed(() => query.data.value !== undefined || query.isError.value),
        };
    })!;
    return read;
};

// A write answers the house as it now stands, which is what every reader of it draws next.
const adopt = (house: SealHouse): SealHouse => {
    queryClient.setQueryData(rpcKey(`seal.house`), house);
    return house;
};

/** The house rule for the active sandbox, undefined until it answers (or where it cannot: an older daemon). */
export const useSealHouse = () => {
    const { house, loaded } = houseRead();
    return {
        house,
        loaded,
        /** Sets the house rule (Full access or the owner; refused where the organisation fixed it). */
        setMode: async (mode: SealMode): Promise<SealHouse> => adopt(await sandboxRpc.seal.setHouse({ mode })),
        /** The reader's own answer to whether their new conversations start private, where the rule leaves it to them. */
        setOwnDefault: async (on: boolean): Promise<SealHouse> => adopt(await sandboxRpc.seal.setDefault({ private: on })),
    };
};
