import type { CapabilityCatalogEntry } from "@intentic/capability-catalog";
import type { NoticeModel } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { computed, type Ref } from "vue";
import type { PageMove } from "./capabilityRoute";
import type { CatalogTile } from "./model/slices";

// Walks the recommended tiles one at a time, reusing each tile's own ordinary form rather than a separate wizard, and
// takes "Not needed" for an answer. The queue is derived, never snapshotted, so connecting or dismissing a tile
// removes it by itself.

// Recommended tiles nothing is connected on yet, in catalog order.
export const setupQueue = (tiles: readonly CatalogTile[]): CapabilityCatalogEntry[] =>
    tiles.filter((tile) => tile.recommendation !== undefined && tile.connected === 0).map((tile) => tile.entry);

// The tile after this one, read before the change that removes it from the queue, or "next" answers wrong; one no
// longer queued is followed by the queue's head.
export const nextAfter = (queue: readonly CapabilityCatalogEntry[], entry: CapabilityCatalogEntry): string | undefined => {
    const at = queue.findIndex((candidate) => candidate.id === entry.id);
    return (at === -1 ? queue[0] : queue[at + 1])?.id;
};

export interface WalkHost {
    readonly tiles: Readonly<Ref<readonly CatalogTile[]>>;
    readonly selected: Readonly<Ref<CapabilityCatalogEntry | undefined>>;
    // Whether the URL has the walk running (`setup`).
    readonly walking: Readonly<Ref<boolean>>;
    readonly move: (move: PageMove) => void;
    readonly dismissRecommendation: { readonly mutateAsync: (entry: string) => Promise<unknown> };
    readonly error: Ref<NoticeModel | null>;
}

export const useSetupWalk = ({ tiles, selected, walking, move, dismissRecommendation, error }: WalkHost) => {
    const walkQueue = computed(() => setupQueue(tiles.value));
    const goNext = (entry: string | undefined): void => move(entry === undefined ? { kind: `finish` } : { kind: `tile`, entry });
    // Where a finished tile goes: onward through the walk, or back to its slice.
    const leaveTile = (next: string | undefined): void => (walking.value ? goNext(next) : move({ kind: `back` }));
    // Where the walk goes after this tile, decided before the change that takes it out of the queue.
    const onwardFrom = (entry: CapabilityCatalogEntry): string | undefined => (walking.value ? nextAfter(walkQueue.value, entry) : undefined);
    const startSetup = (): void => {
        const first = walkQueue.value[0];
        if (first !== undefined) {
            move({ kind: `walk`, entry: first.id });
        }
    };
    const skip = (): void => {
        if (selected.value !== undefined) {
            goNext(nextAfter(walkQueue.value, selected.value));
        }
    };
    // "Not needed" quiets the suggestion until its evidence changes; the tile itself is untouched, only the badge goes.
    const dismiss = async (entry: CapabilityCatalogEntry): Promise<void> => {
        const next = onwardFrom(entry);
        error.value = null;
        try {
            await dismissRecommendation.mutateAsync(entry.id);
        } catch (err) {
            error.value = noticeFrom(err, `Could not dismiss that suggestion.`);
            return;
        }
        leaveTile(next);
    };
    return { walkQueue, leaveTile, onwardFrom, startSetup, skip, dismiss };
};
