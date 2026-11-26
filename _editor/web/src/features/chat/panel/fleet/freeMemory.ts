import { errorMessage } from "@intentic/base/errors";
import type { MemoryReclaimResult } from "@intentic/sandbox-contract/schemas/metrics";
import { t } from "@intentic/ui/i18n";
import { ref } from "vue";
import { useSandboxScope } from "../../../../client/sandbox/scope/useSandboxScope";
import { reclaimWords } from "./fleetWords";

// "Free memory" on the composer's strip (POST /system/memory/reclaim, offered by fleetWords.ts offersReclaim): one press
// at a time, its progress, and what came of it in words. The daemon reads the computer before and a few seconds after,
// so a press takes that long; the answer stays on the strip until the person waves it away or presses again.

export type FreeMemoryState =
    | { readonly kind: `idle` }
    | { readonly kind: `running` }
    | { readonly kind: `done`; readonly text: string }
    | { readonly kind: `failed`; readonly text: string };

// The press of the sandbox the strip stands in, read at setup.
const scopedReclaim = (): (() => Promise<MemoryReclaimResult>) => {
    const { rpc } = useSandboxScope();
    return () => rpc.system.reclaimMemory();
};

// `reclaim` is the daemon's press, swapped in a test.
export const useFreeMemory = (reclaim: () => Promise<MemoryReclaimResult> = scopedReclaim()) => {
    const state = ref<FreeMemoryState>({ kind: `idle` });
    const press = async (): Promise<void> => {
        if (state.value.kind === `running`) {
            return;
        }
        state.value = { kind: `running` };
        try {
            state.value = { kind: `done`, text: reclaimWords(await reclaim()) };
        } catch (error) {
            state.value = { kind: `failed`, text: t(`chat.fleetAdvice.freeFailed`, { error: errorMessage(error) }) };
        }
    };
    const clear = (): void => {
        if (state.value.kind !== `running`) {
            state.value = { kind: `idle` };
        }
    };
    return { state, press, clear };
};
