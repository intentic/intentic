import { longFrameFields, recordPerf, stalledPaths } from "./perf";

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

// Loud while it is news, sampled once it is a pattern: a phone misses the frame budget on most frames of a streamed
// reply, and a warning per frame was work on that frame.
describe(`slow span warnings`, () => {
    it(`warns for the first few slow spans of an op, then one in fifty`, () => {
        const warn = jest.spyOn(console, `warn`).mockImplementation(() => {});
        for (let index = 0; index < 100; index += 1) {
            recordPerf(`test.sampled`, 1_000);
        }
        expect(warn.mock.calls.filter(([line]) => String(line).startsWith(`[perf] slow test.sampled`))).toHaveLength(7);
    });
});

// What a long frame says about itself: how long, how much was style and layout, and its heaviest scripts by file and
// function, never a path.
describe(`longFrameFields`, () => {
    it(`names the heaviest scripts first, by file and function, with their forced layout`, () => {
        const script = (sourceFunctionName: string, duration: number) => ({
            invoker: `DIV.onclick`,
            invokerType: `event-listener`,
            sourceURL: `https://app.intentic.dev/assets/ChatPanel-abc.js?x=1`,
            sourceFunctionName,
            duration,
            forcedStyleAndLayoutDuration: 12.4,
        });
        const fields = longFrameFields({
            duration: 812.4,
            blockingDuration: 760,
            startTime: 1_000,
            renderStart: 1_700,
            styleAndLayoutStart: 1_720,
            scripts: [script(`light`, 40), script(`heavy`, 700)],
        });

        expect(fields).toEqual({
            ms: 812,
            blockingMs: 760,
            styleLayoutMs: 92,
            renderMs: 112,
            scripts: `ChatPanel-abc.js:heavy (DIV.onclick) 700ms, 12ms forced\nChatPanel-abc.js:light (DIV.onclick) 40ms, 12ms forced`,
        });
    });
});
