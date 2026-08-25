import { computed, type ComputedRef, shallowRef } from "vue";
import { z } from "zod";
import { storedValue, storeValue } from "../composables/browserStorage";
import { useSandbox } from "../composables/sandbox/useSandbox";

/* THE TILES THIS READER KEEPS ON THE RAIL, whatever the app's own table says about them.
 *
 * `RAIL_GROUPS` decides which areas are seated for everybody (registry.ts): four permanent tiles, and the rest
 * seated exactly while they are badging. That is the right default and it cannot be the right answer for every
 * reader, because the rule is about what a surface DOES and the exceptions are about what a particular person
 * does all day. Someone who lives in Deployments watches an estate that is healthy almost all the time, which
 * under the default is a tile they only ever see when it is too late to be told; someone who never opens
 * Documentation is paying nothing for it either way. A pin is that person overruling the table, once, for the
 * one tile it is wrong about, instead of the table being loosened for everyone.
 *
 * BY ROUTE, NOT BY VIEW ID, which is the same identity railMemory keeps its seats under and for the same reason:
 * one extension can contribute several tiles (a Deployments tile per Komodo connection) and they share an id, so
 * the route is the only thing that tells one of them from another. Pinning `staging` must not drag `production`
 * onto the rail with it.
 *
 * PER SANDBOX, in localStorage. A different sandbox has different repositories, different connections and
 * therefore a different rail, so a pin is no more portable between two of them than the seats it overrules are.
 * It is also chrome, not data: nothing is lost by it being local to a browser, and putting it on the account
 * would mean a preference round-trip before the rail could draw. */

const StoredPinsSchema = z.array(z.string());

const storageKey = (sandboxId: string | undefined): string => `intentic.railPins.${sandboxId ?? `local`}`;

const readPins = (sandboxId: string | undefined): ReadonlySet<string> => {
    const raw = storedValue(storageKey(sandboxId));
    if (raw === undefined) {
        return new Set();
    }
    // A payload this build can't read is not a preference: the rail falls back to the table, which is a rail
    // that works, rather than to a half-parsed list of routes.
    try {
        const parsed = StoredPinsSchema.safeParse(JSON.parse(raw) as unknown);
        return new Set(parsed.success ? parsed.data : []);
    } catch {
        return new Set();
    }
};

// Bumped on every write, and read by the computed below purely to invalidate it: localStorage is not reactive,
// and a pin that only took effect on the next reload would be a menu row that appears to do nothing.
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
