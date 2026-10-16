import { clearWarmSources, LEAN_PLAN_LIMIT, leanReadAhead, PLAN_LIMIT, registerWarmSource, warmPlan, type WarmBand, type WarmTask } from "./warmPlan";

const wish = (key: string, band: WarmBand): WarmTask => ({ key, band, have: () => false, read: () => Promise.resolve() });

afterEach(() => clearWarmSources());

describe(`the wish list`, () => {
    it(`orders by band, whatever order the sources were asked in`, () => {
        registerWarmSource(() => [wish(`r`, `rail`), wish(`w`, `work`)]);
        registerWarmSource(() => [wish(`n`, `now`), wish(`e`, `near`)]);
        expect(warmPlan().map((task) => task.key)).toEqual([`n`, `e`, `w`, `r`]);
    });

    it(`keeps each source's own order within a band: a list is warmed the way it is drawn`, () => {
        registerWarmSource(() => [wish(`first`, `near`), wish(`second`, `near`), wish(`third`, `near`)]);
        expect(warmPlan().map((task) => task.key)).toEqual([`first`, `second`, `third`]);
    });

    it(`warms a thing two surfaces both want exactly once, on the nearer one's terms`, () => {
        // The board wants an agent's changes so its card can open; the review wants them because it is showing
        // them. One read, and it keeps the band of whoever spoke first.
        registerWarmSource(() => [wish(`agent:1:changes`, `now`)]);
        registerWarmSource(() => [wish(`agent:1:changes`, `rail`)]);
        const plan = warmPlan();
        expect(plan).toHaveLength(1);
        expect(plan[0]?.band).toBe(`now`);
    });

    it(`carries on when one surface throws: its wishes are missing, not everyone else's`, () => {
        registerWarmSource(() => {
            throw new Error(`this screen is mid-teardown`);
        });
        registerWarmSource(() => [wish(`survivor`, `near`)]);
        expect(warmPlan().map((task) => task.key)).toEqual([`survivor`]);
    });

    it(`is bounded, so no source can make the plan grow with the workspace`, () => {
        registerWarmSource(() => Array.from({ length: PLAN_LIMIT + 50 }, (_, index) => wish(`row-${index}`, `work`)));
        expect(warmPlan()).toHaveLength(PLAN_LIMIT);
    });

    it(`forgets a surface that has gone away`, () => {
        const dispose = registerWarmSource(() => [wish(`gone`, `near`)]);
        expect(warmPlan()).toHaveLength(1);
        dispose();
        expect(warmPlan()).toHaveLength(0);
    });
});

// A phone, a reader saving data or a slow link keeps only the nearest wishes: each read is a transcript or a diff over
// that connection, validated on that CPU, again after every reconnect.
describe(`a lean read-ahead`, () => {
    it(`keeps only the nearest wishes`, () => {
        registerWarmSource(() => Array.from({ length: 60 }, (_, index) => wish(`k${index}`, index < 5 ? `now` : `rail`)));
        const lean = warmPlan(() => true);
        expect(lean).toHaveLength(LEAN_PLAN_LIMIT);
        expect(lean.slice(0, 5).map((task) => task.key)).toEqual([`k0`, `k1`, `k2`, `k3`, `k4`]);
        expect(warmPlan(() => false)).toHaveLength(60);
    });

    it(`is lean on a touch screen, a narrow one, a save-data reader and a slow link, and nowhere else`, () => {
        const desk = { mobile: false, coarse: false };
        expect(leanReadAhead({ mobile: true, coarse: false })).toBe(true);
        expect(leanReadAhead({ mobile: false, coarse: true })).toBe(true);
        expect(leanReadAhead(desk, { saveData: true })).toBe(true);
        expect(leanReadAhead(desk, { effectiveType: `3g` })).toBe(true);
        expect(leanReadAhead(desk, { effectiveType: `4g`, saveData: false })).toBe(false);
        expect(leanReadAhead(desk)).toBe(false);
    });
});
