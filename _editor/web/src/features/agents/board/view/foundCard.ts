import { computed, type Ref, watch } from "vue";
import type { FleetAgent } from "../../fleet/useAgents-fleet";
import type { ViewEvent } from "./boardView";

// The card a query names by its id (idMatch.ts), as the board treats it: the lanes lead with it (boardLanes), and here
// it is brought into sight wherever it is drawn, the archive's matches unfolding for one filed there, and Enter in the
// field opens it. One card only: two cards named whole (two sandboxes can mint the same id) are each marked, and
// neither is picked for the reader.

export interface FoundHost {
    readonly filter: {
        readonly needle: Readonly<Ref<string>>;
        readonly exact: (agent: FleetAgent) => boolean;
    };
    readonly lanes: {
        // Every card and child row the lanes draw, in drawing order.
        readonly paneOrder: Readonly<Ref<readonly FleetAgent[]>>;
        // What the query found in the archive, drawn under the lanes while `beyondVisible`.
        readonly archivedHits: Readonly<Ref<readonly FleetAgent[]>>;
        readonly beyondVisible: Readonly<Ref<boolean>>;
    };
    readonly move: (event: ViewEvent) => void;
    // Scrolls a card or child row into view once it is drawn (laneMotion).
    readonly reveal: (id: string) => Promise<void>;
    // What a click on the card does (useCardFocus.focusAgent).
    readonly open: (agent: FleetAgent) => void;
}

export const useFoundCard = (host: FoundHost) => {
    const { filter, lanes } = host;
    const found = computed<FleetAgent | undefined>(() => {
        const drawn = lanes.beyondVisible.value ? [...lanes.paneOrder.value, ...lanes.archivedHits.value] : lanes.paneOrder.value;
        const named = drawn.filter(filter.exact);
        return named.length === 1 ? named[0] : undefined;
    });
    const filed = computed(() => found.value !== undefined && lanes.archivedHits.value.includes(found.value));
    // Re-run on every query, not only when the card changes: a new query folds the archive's matches (boardView's
    // `requery`), and the card the query still names must not fold away with them. After the render, so that fold has
    // landed and the card is drawn where it is being scrolled to.
    watch(
        () => [filter.needle.value, found.value?.id] as const,
        ([, id]) => {
            if (id === undefined) {
                return;
            }
            if (filed.value && lanes.beyondVisible.value) {
                host.move({ kind: `unfold` });
                return;
            }
            void host.reveal(id);
        },
        { flush: `post` },
    );
    // True when there was a card to open, so the field knows whether its Enter did anything.
    const openFound = (): boolean => {
        if (found.value === undefined) {
            return false;
        }
        host.open(found.value);
        return true;
    };
    return { found, openFound };
};
