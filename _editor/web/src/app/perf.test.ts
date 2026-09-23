import { recordPerf, stalledPaths } from "./perf";

// `stalledPaths` is what the connecting gate turns into an accusation ("this route is what you are waiting on"), so a
// wrong op, window or threshold here names an innocent path on a screen somebody is reading during an outage.

beforeEach(() => {
    // Slow spans warn by design; the suite is not the place to read them.
    jest.spyOn(console, `warn`).mockImplementation(() => {});
});

afterEach(() => {
    jest.restoreAllMocks();
});

describe(`stalledPaths`, () => {
    it(`reports the path that ran out its deadline most often, worst first`, () => {
        recordPerf(`rpc.request`, 45_001, { path: `/x/acme.one/slow` });
        recordPerf(`rpc.request`, 45_002, { path: `/x/acme.two/slower` });
        recordPerf(`rpc.request`, 45_003, { path: `/x/acme.two/slower` });
        expect(stalledPaths(45_000, 60_000).slice(0, 2)).toEqual([`/x/acme.two/slower`, `/x/acme.one/slow`]);
    });

    it(`leaves out spans that were merely slow, since slowness is not a stall`, () => {
        recordPerf(`rpc.request`, 44_999, { path: `/nearly/there` });
        expect(stalledPaths(45_000, 60_000)).not.toContain(`/nearly/there`);
    });

    it(`leaves out stalls older than the window, which explain a previous outage and not this one`, () => {
        recordPerf(`rpc.request`, 45_000, { path: `/last/time` });
        expect(stalledPaths(45_000, 60_000, Date.now() + 61_000)).not.toContain(`/last/time`);
    });

    it(`counts daemon calls only: a query or a frame is time spent in this tab, not a route going quiet`, () => {
        recordPerf(`query.fetch`, 90_000, { path: `/not/a/request` });
        recordPerf(`chat.frame`, 90_000, { path: `/not/a/request` });
        expect(stalledPaths(45_000, 60_000)).not.toContain(`/not/a/request`);
    });

    it(`ignores a span with no path, which names nothing a reader could act on`, () => {
        recordPerf(`rpc.request`, 45_000, { method: `GET` });
        expect(stalledPaths(45_000, 60_000)).not.toContain(undefined);
    });
});
