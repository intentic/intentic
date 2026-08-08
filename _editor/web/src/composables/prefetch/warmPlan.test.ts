import { afterEach, describe, expect, it } from "vitest";
import { clearWarmSources, PLAN_LIMIT, registerWarmSource, warmPlan, type WarmBand, type WarmTask } from "./warmPlan";

const wish = (key: string, band: WarmBand): WarmTask => ({ key, band, have: () => false, read: () => Promise.resolve() });

afterEach(() => clearWarmSources());

describe(`the wish list`, () => {
    it(`orders by band, whatever order the sources were asked in`, () => {
        registerWarmSource(() => [wish(`r`, `rail`), wish(`w`, `work`)]);
        registerWarmSource(() => [wish(`n`, `now`), wish(`e`, `near`)]);
        expect(warmPlan().map((task) => task.key)).toEqual([`n`, `e`, `w`, `r`]);
    });

    it(`keeps each source's own order within a band — a list is warmed the way it is drawn`, () => {
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

    it(`carries on when one surface throws — its wishes are missing, not everyone else's`, () => {
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
