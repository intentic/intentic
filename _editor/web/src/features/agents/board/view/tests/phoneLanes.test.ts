import { type LaneContent, phoneLanes, type PhoneLaneFacts } from "../phoneLanes";

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
