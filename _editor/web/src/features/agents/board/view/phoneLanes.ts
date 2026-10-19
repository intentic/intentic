import { computed, type Ref } from "vue";
import type { FleetLane } from "../../../../models/agent-status/agentStatus-lanes";
import type { LaneHead } from "./boardLanes";

// WHICH LANES A PHONE'S BOARD DRAWS. Stacked in a column beside the rail, an empty lane is a header and a sentence the
// thumb scrolls past on every visit to reach the one card it came for, so a phone draws only the lanes with something
// in them. The desktop keeps every lane (firstScreen.ts): three columns that shrink to one mid-keystroke would jump the
// board under the pointer, and a column is where a drag lands.

// What one lane has to draw: its rows; only its header (Finished with nothing in it but the archive's door); nothing.
export type LaneContent = `rows` | `header` | `empty`;

export interface PhoneLaneFacts {
    // A first run draws every lane: the first agent's slot is in Active and each lane says what will land in it.
    readonly first: boolean;
    // A card in hand: every lane is a place to drop it.
    readonly dragging: boolean;
    // A query: an empty lane is no match there, which the board says once for all of them (noMatches).
    readonly filtering: boolean;
}

export const phoneLanes = <Lane>(lanes: readonly Lane[], content: (lane: Lane) => LaneContent, facts: PhoneLaneFacts): readonly Lane[] => {
    if (facts.first || facts.dragging) {
        return lanes;
    }
    const drawn = lanes.filter((lane) => content(lane) !== `empty`);
    // A board with nothing on it at all keeps its lanes, whose own lines say what each is for; under a query it draws
    // none of them, the filter's empty state saying it once.
    return drawn.length === 0 && !facts.filtering ? lanes : drawn;
};

// The board's own reads, by name, so deciding its lanes is this module's page rather than one more of the board's.
export interface PhoneLanesHost {
    readonly mobile: Readonly<Ref<boolean>>;
    readonly heads: Readonly<Ref<readonly LaneHead[]>>;
    readonly view: Readonly<Ref<{ readonly archive: boolean }>>;
    readonly lanes: {
        readonly cardsFor: (lane: FleetLane) => readonly unknown[];
        readonly runsFor: (lane: FleetLane) => readonly unknown[];
        readonly hiddenFinished: Readonly<Ref<number>>;
        readonly archiveSize: Readonly<Ref<number>>;
        readonly first: Readonly<Ref<boolean>>;
    };
    readonly scope: { readonly scopedHeld: Readonly<Ref<readonly unknown[]>>; readonly attentionElsewhere: Readonly<Ref<number>> };
    readonly dragging: Readonly<Ref<boolean>>;
    readonly filtering: Readonly<Ref<boolean>>;
    // Finished holds the example card until the reader's own first agent finishes (ExampleAgentCard).
    readonly exampleShown: Readonly<Ref<boolean>>;
}

// The board's lanes as a phone draws them (all of them elsewhere), and per lane: whether it is Finished drawn for its
// archive door alone, which says nothing under its header; and whether it says its empty line.
export const usePhoneLanes = (host: PhoneLanesHost) => {
    const { mobile, view, lanes, scope, dragging, filtering } = host;
    const rows = (key: FleetLane): number => lanes.cardsFor(key).length + lanes.runsFor(key).length;
    const content = (key: FleetLane): LaneContent => {
        const held = key === `attention` && !view.value.archive && (scope.scopedHeld.value.length > 0 || scope.attentionElsewhere.value > 0);
        const tail = key === `finished` && (view.value.archive || host.exampleShown.value || (!filtering.value && lanes.hiddenFinished.value > 0));
        if (held || tail || rows(key) > 0) {
            return `rows`;
        }
        return key === `finished` && !filtering.value && lanes.archiveSize.value > 0 ? `header` : `empty`;
    };
    const facts = computed(() => ({ first: lanes.first.value, dragging: dragging.value, filtering: filtering.value }));
    const drawnLanes = computed(() => (mobile.value ? phoneLanes(host.heads.value, (head) => content(head.key), facts.value) : host.heads.value));
    const bareLane = (key: FleetLane): boolean => mobile.value && !lanes.first.value && !dragging.value && content(key) === `header`;
    const saysEmpty = (key: FleetLane): boolean =>
        !bareLane(key) && rows(key) === 0 && !(key === `attention` && scope.scopedHeld.value.length > 0);
    return { drawnLanes, bareLane, saysEmpty };
};
