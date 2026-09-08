import { computed, type ComputedRef, shallowRef } from "vue";
import { z } from "zod";
import { storedValue, storeValue } from "../../lib/browserStorage";
import { useSandbox } from "../../features/sandbox/client/useSandbox";

// A reader's per-tile override of the default rail table (registry.ts's `RAIL_GROUPS`), for the one tile the
// default is wrong about for them. Kept by route, not view id, so pinning one of an extension's several same-id
// tiles (e.g. one Komodo connection) doesn't drag its siblings on. Per sandbox, in localStorage: chrome, not data.

const StoredPinsSchema = z.array(z.string());

const storageKey = (sandboxId: string | undefined): string => `intentic.railPins.${sandboxId ?? `local`}`;

const readPins = (sandboxId: string | undefined): ReadonlySet<string> => {
    const raw = storedValue(storageKey(sandboxId));
    if (raw === undefined) {
        return new Set();
    }
    // An unreadable payload isn't a preference: falls back to the default table rather than a half-parsed list.
    try {
        const parsed = StoredPinsSchema.safeParse(JSON.parse(raw) as unknown);
        return new Set(parsed.success ? parsed.data : []);
    } catch {
        return new Set();
    }
};

// Bumped on every write and read by `pinned` purely to invalidate it, since localStorage isn't reactive.
const writes = shallowRef(0);

export interface RailPins {
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
        const next = new Set(pinned.value);
        if (!next.delete(to)) {
            next.add(to);
        }
        storeValue(storageKey(activeSandboxId.value), JSON.stringify([...next]));
        writes.value += 1;
    };
    return { pinned, isPinned: (to: string): boolean => pinned.value.has(to), toggle };
}
