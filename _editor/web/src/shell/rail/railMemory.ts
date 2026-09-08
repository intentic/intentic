import type { IconName } from "@intentic/ui";
import { computed, type ComputedRef, type Ref, watch } from "vue";
import { z } from "zod";
import { storedValue, storeValue } from "../../lib/browserStorage";
import { useSandbox } from "../../features/sandbox/client/useSandbox";

// Rail tiles arrive in waves, each re-seating everything below it as it lands. Once a load completes, the layout
// is remembered per sandbox in localStorage (readable before anything connects) and drawn as dim placeholders next
// load, replaced as each tile wakes. Ghosts are inert, dropped once the live rail is complete, never treated as truth.

// One seat in the rail's run; the identity AreaTile builds on. A badge is never kept: it's live state, and a
// remembered count would already be stale.
export interface RailSeat {
    readonly id: string;
    readonly to: string;
    readonly label: string;
    readonly icon?: IconName;
}

// A seat held open for a tile not back yet; same shape as RailSeat, flagged, so the rail renders one list, not a
// parallel placeholder template.
export type GhostSeat = RailSeat & { readonly ghost: true };

const asGhost = (seat: RailSeat): GhostSeat => ({ ...seat, ghost: true });

const storageKey = (sandboxId: string | undefined): string => `intentic.railSeats.${sandboxId ?? `local`}`;

// Icon kept as a plain string; an unknown name falls back, costing the placeholder its glyph, not its seat.
const StoredSeatsSchema = z.array(
    z.object({
        id: z.string(),
        to: z.string(),
        label: z.string(),
        icon: z.string().optional(),
    }),
);

const readSeats = (sandboxId: string | undefined): readonly RailSeat[] => {
    const raw = storedValue(storageKey(sandboxId));
    if (raw === undefined) {
        return [];
    }
    // An unreadable or stale-shaped payload counts as no memory; the rail just grows as if none was remembered.
    try {
        const parsed = StoredSeatsSchema.safeParse(JSON.parse(raw) as unknown);
        return parsed.success ? (parsed.data as readonly RailSeat[]) : [];
    } catch {
        return [];
    }
};

// Ghost seats to draw beside the live ones, plus the writer that keeps them current. `settled` (the rail is
// complete) decides when a stale ghost is finally dropped and when the memory is worth overwriting.
export function useRailMemory(live: Ref<readonly RailSeat[]>, settled: Ref<boolean>): ComputedRef<readonly GhostSeat[]> {
    const { activeSandboxId } = useSandbox();
    const remembered = computed<readonly RailSeat[]>(() => readSeats(activeSandboxId.value));

    // Compares against the last written payload so a badge-only recompute doesn't write on every poll.
    let written: string | undefined;
    watch(
        [settled, live, activeSandboxId] as const,
        ([isSettled, seats, sandboxId]) => {
            // An empty run means mid-teardown (the core tiles are unconditional); writing it would erase a good memory.
            if (!isSettled || seats.length === 0) {
                return;
            }
            const key = storageKey(sandboxId);
            const payload = JSON.stringify(seats.map(({ id, to, label, icon }) => ({ id, to, label, ...(icon === undefined ? {} : { icon }) })));
            if (written === `${key}|${payload}`) {
                return;
            }
            written = `${key}|${payload}`;
            storeValue(key, payload);
        },
        { immediate: true },
    );

    return computed<readonly GhostSeat[]>(() => {
        if (settled.value) {
            return [];
        }
        // Matched by route, not id: several tiles from one extension can share an id but not a route.
        const present = new Set(live.value.map((seat) => seat.to));
        return remembered.value.filter((seat) => !present.has(seat.to)).map(asGhost);
    });
}
