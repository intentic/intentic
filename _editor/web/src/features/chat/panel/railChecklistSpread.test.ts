import { spreadsChecklist, type SpreadReading } from "./railChecklistSpread";

// A 1000px rail with 240px to spare beside it, plan headroom 300px tall, the checklist's heading 50px.
const reading = (over: Partial<SpreadReading>): SpreadReading => ({
    rows: 400,
    chrome: 50,
    capacity: 300,
    rail: 1000,
    free: 300,
    extra: 240,
    spread: false,
    ...over,
});

describe(`spreadsChecklist`, () => {
    it(`keeps a list that fits beside plan headroom in one column`, () => {
        expect(spreadsChecklist(reading({ rows: 600 }))).toBe(false);
    });

    it(`spreads the longer half once the two no longer fit together`, () => {
        expect(spreadsChecklist(reading({ rows: 700 }))).toBe(true);
    });

    it(`never spreads a list shorter than half the rail, which the grid lets keep its whole height`, () => {
        expect(spreadsChecklist(reading({ rows: 400, capacity: 900 }))).toBe(false);
    });

    it(`stays one column without the width a second column takes`, () => {
        expect(spreadsChecklist(reading({ rows: 1400, free: 239 }))).toBe(false);
    });

    it(`stays spread until the list fits with room to spare, so rounding never toggles it`, () => {
        expect(spreadsChecklist(reading({ rows: 648, spread: true }))).toBe(true);
        expect(spreadsChecklist(reading({ rows: 648, spread: false }))).toBe(false);
        expect(spreadsChecklist(reading({ rows: 640, spread: true }))).toBe(false);
    });
});
