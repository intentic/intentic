import { parseJsonWith } from "@intentic/base/json";
import { computed, type ComputedRef, shallowRef } from "vue";
import { z } from "zod";
import { storedValue, storeValue } from "../../app/storage/browserStorage";
import { useSandbox } from "../../client/sandbox/useSandbox";
import { railKey } from "./railMemory";

// A reader's per-tile override of the default rail table (registry.ts's `RAIL_GROUPS`), for the one tile the
// default is wrong about for them. Kept by page (railMemory.ts `railKey`), not view id, so pinning one of an extension's
// several same-id tiles (e.g. one Komodo connection) doesn't drag its siblings on, and not by address, which names the
// frame and the sandbox a tile opens in. Per sandbox, in localStorage: chrome, not data.

const StoredPinsSchema = z.array(z.string());

const storageKey = (sandboxId: string | undefined): string => `intentic.railPins.${sandboxId ?? `local`}`;

const readPins = (sandboxId: string | undefined): ReadonlySet<string> => {
    const raw = storedValue(storageKey(sandboxId));
    if (raw === undefined) {
        return new Set();
    }
    // An unreadable payload isn't a preference: falls back to the default table rather than a half-parsed list.
    return new Set((parseJsonWith(raw, StoredPinsSchema) ?? []).map(railKey));
};

// Bumped on every write and read by `pinned` purely to invalidate it, since localStorage isn't reactive.
// allow(module-state): a counter invalidating reads of the stored pins
const writes = shallowRef(0);

export interface RailPins {
    /** The pinned tiles, by their keys (railKey), not their addresses: ask `isPinned` with an address. */
    readonly pinned: ComputedRef<ReadonlySet<string>>;
    readonly isPinned: (to: string) => boolean;
    readonly toggle: (to: string) => void;
}

export function useRailPins(): RailPins {
    const { activeSandboxId } = useSandbox();
    const pinned = computed<ReadonlySet<string>>(() => {
        void writes.value;
        return readPins(activeSandboxId.value);
    });
    const toggle = (to: string): void => {
        const key = railKey(to);
        const next = new Set(pinned.value);
        if (!next.delete(key)) {
            next.add(key);
        }
        storeValue(storageKey(activeSandboxId.value), JSON.stringify([...next]));
        writes.value += 1;
    };
    return { pinned, isPinned: (to: string): boolean => pinned.value.has(railKey(to)), toggle };
}
