import type { IconName } from "@intentic/ui";
import { computed, type ComputedRef, type Ref, watch } from "vue";
import { z } from "zod";
import { storedValue, storeValue } from "../../lib/browserStorage";
import { useSandbox } from "../../features/sandbox/client/useSandbox";

// Rail tiles arrive in waves, each pushing everything below it down as it lands. Once a load completes, the layout
// is remembered per sandbox in localStorage (readable before anything connects) and drawn as dim placeholders next
// load, replaced as each tile wakes. Ghosts are inert, dropped once the live rail is complete, never treated as truth.

// One tile in the rail's run; the identity SectionTile builds on. A badge is never kept: it's live state, and a
// remembered count would already be stale.
export interface RailTile {
    readonly id: string;
    readonly to: string;
    readonly label: string;
    readonly icon?: IconName;
    // Letters drawn in place of the icon (Activation.monogram): the open project's, on the Projects tile.
    readonly monogram?: string;
}

// A tile held open for a tile not back yet; same shape as RailTile, flagged, so the rail renders one list, not a
// parallel placeholder template.
export type GhostTile = RailTile & { readonly ghost: true };

const asGhost = (tile: RailTile): GhostTile => ({ ...tile, ghost: true });

const storageKey = (sandboxId: string | undefined): string => `intentic.railTiles.${sandboxId ?? `local`}`;

// Icon kept as a plain string; an unknown name falls back, costing the placeholder its glyph, not its tile.
const StoredTilesSchema = z.array(
    z.object({
        id: z.string(),
        to: z.string(),
        label: z.string(),
        icon: z.string().optional(),
    }),
);

const readTiles = (sandboxId: string | undefined): readonly RailTile[] => {
    const raw = storedValue(storageKey(sandboxId));
    if (raw === undefined) {
        return [];
    }
    // An unreadable or stale-shaped payload counts as no memory; the rail just grows as if none was remembered.
    try {
        const parsed = StoredTilesSchema.safeParse(JSON.parse(raw) as unknown);
        return parsed.success ? (parsed.data as readonly RailTile[]) : [];
    } catch {
        return [];
    }
};

// Ghost tiles to draw beside the live ones, plus the writer that keeps them current. `settled` (the rail is
// complete) decides when a stale ghost is finally dropped and when the memory is worth overwriting.
export function useRailMemory(live: Ref<readonly RailTile[]>, settled: Ref<boolean>): ComputedRef<readonly GhostTile[]> {
    const { activeSandboxId } = useSandbox();
    const remembered = computed<readonly RailTile[]>(() => readTiles(activeSandboxId.value));

    // Compares against the last written payload so a badge-only recompute doesn't write on every poll.
    let written: string | undefined;
    watch(
        [settled, live, activeSandboxId] as const,
        ([isSettled, tiles, sandboxId]) => {
            // An empty run means mid-teardown (the core tiles are unconditional); writing it would erase a good memory.
            if (!isSettled || tiles.length === 0) {
                return;
            }
            const key = storageKey(sandboxId);
            const payload = JSON.stringify(tiles.map(({ id, to, label, icon }) => ({ id, to, label, ...(icon === undefined ? {} : { icon }) })));
            if (written === `${key}|${payload}`) {
                return;
            }
            written = `${key}|${payload}`;
            storeValue(key, payload);
        },
        { immediate: true },
    );

    return computed<readonly GhostTile[]>(() => {
        if (settled.value) {
            return [];
        }
        // Matched by route, not id: several tiles from one extension can share an id but not a route.
        const present = new Set(live.value.map((tile) => tile.to));
        return remembered.value.filter((tile) => !present.has(tile.to)).map(asGhost);
    });
}
