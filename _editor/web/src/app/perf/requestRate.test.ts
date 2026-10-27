import { recordPerf, requestRoute, resetPerf, takeRequestTally } from "./perf";
import { requestRateFields } from "./requestRate";

test("a request is tallied by its route, with the ids in its path folded out", () => {
    expect(requestRoute(`GET`, `/agents/coral-moth-xd28/diff`)).toBe(`GET /agents/:id/diff`);
    expect(requestRoute(`POST`, `/usage/plan-limits/refresh`)).toBe(`POST /usage/plan-limits/refresh`);
});

test("the tally counts daemon calls only, and a take zeroes it", () => {
    resetPerf();
    recordPerf(`rpc.request`, 12, { path: `/agents/sub-true-gale-jcu5/diff`, method: `GET` });
    recordPerf(`rpc.request`, 30, { path: `/agents/coral-moth-xd28/diff`, method: `GET` });
    recordPerf(`query.fetch`, 30, { key: `agents` });
    expect([...takeRequestTally()]).toEqual([[`GET /agents/:id/diff`, 2]]);
    expect(takeRequestTally().size).toBe(0);
});

test("a period's report names the window, its rate and its busiest routes", () => {
    const tally = new Map([
        [`GET /chores`, 4],
        [`GET /ci/runs`, 18],
    ]);
    expect(requestRateFields(tally, 2 * 60_000, `floating:chat`)).toEqual({
        window: `floating:chat`,
        minutes: 2,
        requests: 22,
        perMinute: 11,
        routes: `GET /ci/runs ×18, GET /chores ×4`,
    });
    expect(requestRateFields(new Map(), 60_000, `main`)).toBeUndefined();
});
