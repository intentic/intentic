import { computed, type ComputedRef, watch } from "vue";
import { activeSandboxId } from "../../../../app/storage/activeSandbox";
import { capacityRailKey, removeStoredValue, storedValue, storeValue } from "../../../../app/storage/browserStorage";
import { accountsLoaded } from "../../../../models/providers/providerAccounts";
import { hasCapacity } from "./chatCapacity";

// WHETHER THE USAGE RAIL STANDS before the accounts are read. Reserving it while unread keeps the transcript from
// reflowing when the figures land, but on a sandbox with nothing connected (every fresh one) that drew three skeleton
// bars for as long as the read took, and then took the column away: a promise of figures that were never coming.
// So the rail is held open only where it last had something to show. A sandbox seen with figures keeps its column
// through the read; one never seen with any draws none until a read says otherwise.

const keyOf = (sandboxId: string | undefined): string => capacityRailKey(sandboxId ?? `local`);

// Written only from a finished read, and only when the answer moved, so a usage poll writes nothing.
const remember = (has: boolean | undefined): void => {
    if (has === undefined) {
        return;
    }
    const key = keyOf(activeSandboxId.value);
    if (has && storedValue(key) === undefined) {
        storeValue(key, `1`);
    }
    if (!has && storedValue(key) !== undefined) {
        removeStoredValue(key);
    }
};

/** Whether the rail has, or is expected to have, something to show; read live once the accounts are. */
export const useCapacityRail = (): ComputedRef<boolean> => {
    watch(() => (accountsLoaded.value ? hasCapacity() : undefined), remember, { immediate: true });
    // Read from storage while unread, never cached: a sandbox switch resets `accountsLoaded`, which asks again.
    return computed(() => (accountsLoaded.value ? hasCapacity() : storedValue(keyOf(activeSandboxId.value)) !== undefined));
};
