import { computed, ref } from "vue";
import type { FleetLane } from "../../../../../models/agent-status/agentStatus-lanes";
import { type LaneContent, phoneLanes, type PhoneLaneFacts, usePhoneLanes } from "../phoneLanes";

// Pins which lanes a phone's board draws: only the ones with something in them, except where an empty lane still has a
// job (a first run's slot, a drop target), and never a blank board.

const LANES = [`attention`, `active`, `finished`] as const;
type Lane = (typeof LANES)[number];
const AT_REST: PhoneLaneFacts = { first: false, dragging: false, filtering: false };
const holding =
    (contents: Partial<Record<Lane, LaneContent>>) =>
    (lane: Lane): LaneContent =>
        contents[lane] ?? `empty`;

describe(`phoneLanes`, () => {
    it(`draws only the lanes with rows in them`, () => {
        expect(phoneLanes(LANES, holding({ active: `rows` }), AT_REST)).toEqual([`active`]);
        expect(phoneLanes(LANES, holding({ attention: `rows`, finished: `rows` }), AT_REST)).toEqual([`attention`, `finished`]);
    });

    it(`keeps Finished's header while it is the only way to the archive`, () => {
        expect(phoneLanes(LANES, holding({ active: `rows`, finished: `header` }), AT_REST)).toEqual([`active`, `finished`]);
        expect(phoneLanes(LANES, holding({ finished: `header` }), AT_REST)).toEqual([`finished`]);
    });

    it(`draws every lane on a first run and while a card is being dragged`, () => {
        expect(phoneLanes(LANES, holding({}), { ...AT_REST, first: true })).toEqual(LANES);
        expect(phoneLanes(LANES, holding({ active: `rows` }), { ...AT_REST, dragging: true })).toEqual(LANES);
    });

    it(`keeps the lanes of a board with nothing on it, and drops them all when a query matched nothing`, () => {
        expect(phoneLanes(LANES, holding({}), AT_REST)).toEqual(LANES);
        expect(phoneLanes(LANES, holding({}), { ...AT_REST, filtering: true })).toEqual([]);
    });
});

// The card standing in for an agent a press elsewhere is starting (boardLaunches.ts) is a row of Active: a phone draws
// the lane for it, and the lane does not say it is empty under it.
describe(`usePhoneLanes`, () => {
    it(`draws Active for an agent still starting, with no empty line under it`, () => {
        const launching = ref<readonly unknown[]>([]);
        const { drawnLanes, saysEmpty } = usePhoneLanes({
            mobile: ref(true),
            heads: computed(() => LANES.map((key) => ({ key, label: key, empty: ``, first: `` }))),
            view: ref({ archive: false }),
            lanes: {
                cardsFor: (lane: FleetLane) => (lane === `finished` ? [`done`] : []),
                runsFor: () => [],
                hiddenFinished: ref(0),
                archiveSize: ref(0),
                first: ref(false),
            },
            scope: { scopedHeld: ref([]), attentionElsewhere: ref(0) },
            dragging: ref(false),
            filtering: ref(false),
            launching,
        });
        expect(drawnLanes.value.map((lane) => lane.key)).toEqual([`finished`]);
        launching.value = [{ key: `press` }];
        expect(drawnLanes.value.map((lane) => lane.key)).toEqual([`active`, `finished`]);
        expect(saysEmpty(`active`)).toBe(false);
    });
});
