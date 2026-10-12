import { freshImport, advanceTimersByTimeAsync, stubGlobal } from "@intentic/testing/bun";

// Pins the module's three promises to its callers (an error handler, an unload hook, a perf recorder): it never
// throws, never blocks, and never grows unbounded while the thing it's describing is still going wrong.

const target = { base: `https://sandbox.example`, connectToken: undefined };
const fetched: { body: unknown; requestId: string | null }[] = [];

// A Request does not carry `keepalive` back off the object under this runtime, so what the module asked for is
// recorded as it is built.
const inits: RequestInit[] = [];
class RecordingRequest extends Request {
    constructor(input: RequestInfo | URL, init?: RequestInit) {
        super(input, init);
        inits.push(init ?? {});
    }
}
stubGlobal(`Request`, RecordingRequest);

jest.mock(`../client/sandbox/sandboxTarget`, () => ({ currentSandboxTarget: () => currentTarget }));
jest.mock(`../client/sandbox/sandboxAuthFetch`, () => ({
    sandboxAuthenticatedFetch: async (request: Request) => {
        fetched.push({ body: JSON.parse(await request.clone().text()), requestId: request.headers.get(`x-intentic-request-id`) });
        return new Response(`{}`);
    },
}));
jest.mock(`./buildEpoch`, () => ({ buildId: () => `test-build` }));
// The SDK's own session id, once it has loaded; undefined is the page before its first idle moment.
let liveReplay: string | undefined;
jest.mock(`./analytics`, () => ({ replaySessionId: () => liveReplay }));

let currentTarget: typeof target | undefined = target;
const { postClientDiagnostics } = await import("../client/sandbox/clientReport");
const { resetPerf, trackPerf } = await import("./perf");

interface Posted {
    events: { event: string; level: string; message: string; requestId?: string; fields?: Record<string, unknown> }[];
    page?: Record<string, unknown>;
}
// SAFETY: every body recorded here is a batch the module under test serialized from this shape.
const batch = (index = 0): Posted => (fetched[index]?.body as Posted | undefined) ?? { events: [] };
const allEvents = (): Posted["events"] => fetched.flatMap((_, index) => batch(index).events);

// Each test's module is fresh, but an earlier one's timers (a pending batch, a minute-long repeat count) still run;
// silencing its sender keeps what it sends late out of the next test's record.
let previous: typeof import("./clientDiagnostics") | undefined;
const load = async (): Promise<typeof import("./clientDiagnostics")> => {
    previous?.sendClientDiagnosticsWith(() => undefined);
    fetched.length = 0;
    inits.length = 0;
    currentTarget = target;
    resetPerf();
    const diagnostics = await freshImport<typeof import("./clientDiagnostics")>("./clientDiagnostics", import.meta.url);
    // Handed the daemon's sender as main.ts hands it in.
    diagnostics.sendClientDiagnosticsWith(postClientDiagnostics);
    previous = diagnostics;
    return diagnostics;
};

beforeEach(() => {
    jest.useFakeTimers();
});

test("a report is batched, then posted with the page's route and build", async () => {
    const { reportClient } = await load();
    reportClient(`vue.render`, `TypeError: x is undefined`, { fields: { stack: `at render` } });

    // Nothing yet: batching is what keeps a burst from being a burst of requests.
    expect(fetched).toHaveLength(0);
    await advanceTimersByTimeAsync(5_000);

    expect(fetched).toHaveLength(1);
    const posted = fetched[0];
    expect((posted?.body as { events: unknown[] } | undefined)?.events[0]).toMatchObject({
        level: `error`,
        event: `vue.render`,
        message: `TypeError: x is undefined`,
        build: `test-build`,
        fields: { stack: `at render` },
    });
});

test("the post is keepalive, which is what makes a report survive the reload it is describing", async () => {
    const { reportClient, flushClientDiagnostics } = await load();
    reportClient(`self-heal.wipe`, `crashed`);
    flushClientDiagnostics();
    await advanceTimersByTimeAsync(0);

    // An ordinary fetch issued before `location.reload()` would be cancelled with the page; keepalive is why the
    // self-heal report survives.
    expect(inits.at(-1)?.keepalive).toBe(true);
});

test("a component looping on the same error sends a few whole reports, then counts, not a flood", async () => {
    const { reportClient } = await load();
    for (let index = 0; index < 400; index++) {
        reportClient(`vue.render`, `the same error every frame`);
    }
    await advanceTimersByTimeAsync(5_000);

    // The first copies go whole; the rest are not thrown away, only counted.
    expect(batch().events.map((entry) => entry.event)).toEqual([`vue.render`, `vue.render`, `vue.render`]);
    expect(batch().events[2]?.fields?.[`repeat`]).toBe(3);

    // A minute on, one line carries the count: the kind is still happening, and says so rather than going silent.
    await advanceTimersByTimeAsync(60_000);
    expect(batch(1).events).toEqual([expect.objectContaining({ event: `vue.render`, fields: { repeat: 400, unsaid: 397 } })]);

    // And it keeps saying so for as long as it keeps happening, instead of being silent for the page's life.
    reportClient(`vue.render`, `the same error every frame`);
    await advanceTimersByTimeAsync(65_000);
    expect(batch(2).events[0]?.fields).toEqual({ repeat: 401, unsaid: 1 });
});

test("copies that differ only by an id, an address or a number are one kind", async () => {
    const { reportClient, kindOf } = await load();
    expect(kindOf(`x`, `no conversation conv_1a2b3c4d5e at https://a.example/x?y=1`)).toBe(
        kindOf(`x`, `no conversation conv_9f8e7d6c5b at https://b.example/z`),
    );
    expect(kindOf(`x`, `took 48ms`)).toBe(kindOf(`x`, `took 1203ms`));
    // Words still tell kinds apart.
    expect(kindOf(`x`, `no conversation`)).not.toBe(kindOf(`x`, `no session`));

    for (let index = 0; index < 10; index++) {
        reportClient(`query.failed`, `no row 7f3a9c${index}d2e1b`);
    }
    await advanceTimersByTimeAsync(5_000);
    expect(batch().events).toHaveLength(3);
});

test("a kind quiet for ten minutes is news again, and its next copy goes whole", async () => {
    const { reportClient } = await load();
    for (let index = 0; index < 5; index++) {
        reportClient(`vue.render`, `boom`);
    }
    await advanceTimersByTimeAsync(11 * 60_000);
    fetched.length = 0;

    reportClient(`vue.render`, `boom`, { fields: { stack: `at render` } });
    await advanceTimersByTimeAsync(5_000);
    expect(batch().events).toEqual([expect.objectContaining({ event: `vue.render`, fields: { stack: `at render` } })]);
});

test("a burst of distinct reports sends early instead of dropping, and what it must drop it names", async () => {
    const { reportClient } = await load();
    for (let index = 0; index < 120; index++) {
        reportClient(index % 3 === 0 ? `vue.render` : `perf.slow`, `distinct ${String.fromCharCode(65 + (index % 26))}${String.fromCharCode(65 + Math.floor(index / 26))}`);
    }
    // Two batch windows: the one that admits the loss leaves room for its own line, so one report waits for the next.
    await advanceTimersByTimeAsync(10_000);

    // The first full queue went at once; the second filled inside the same two seconds, so the rest were dropped.
    const batches = fetched.map((_, index) => batch(index).events);
    expect(batches.every((events) => events.length <= 50)).toBe(true);
    const dropped = allEvents().find((entry) => entry.event === `client.dropped`);
    expect(dropped?.fields?.[`dropped`]).toBe(20);
    expect(String(dropped?.fields?.[`kinds`])).toMatch(/perf\.slow×\d+, vue\.render×\d+/u);
    expect(allEvents().filter((entry) => entry.event !== `client.dropped`)).toHaveLength(100);
});

test("each batch says once which page load, tab and replay it came from, and how the page was served", async () => {
    sessionStorage.setItem(`ph_phc_test_posthog`, JSON.stringify({ $sesid: [1, `replay-session-1`, 0] }));
    const { reportClient } = await load();
    reportClient(`vue.render`, `first`);
    await advanceTimersByTimeAsync(5_000);
    reportClient(`vue.render`, `second`);
    await advanceTimersByTimeAsync(5_000);

    const [one, two] = [batch(0).page, batch(1).page];
    expect(one).toMatchObject({ replay: `replay-session-1`, served: expect.stringMatching(/^dev/u), origin: expect.any(String) });
    expect(String(one?.[`viewport`])).toMatch(/^\d+x\d+@/u);
    expect(one?.[`pageId`]).toEqual(expect.any(String));
    // One page load, one id; the tab id is the tab's, so a reload (a fresh module) keeps it while the page id changes.
    expect(two?.[`pageId`]).toBe(one?.[`pageId`]);
    const reloaded = await load();
    reloaded.reportClient(`vue.render`, `third`);
    await advanceTimersByTimeAsync(5_000);
    expect(batch().page?.[`pageId`]).not.toBe(one?.[`pageId`]);
    expect(batch().page?.[`tabId`]).toBe(one?.[`tabId`]);
    // Every batch carries its own request id, the daemon's join key for its line about the POST.
    expect(fetched[0]?.requestId).toEqual(expect.any(String));
    sessionStorage.removeItem(`ph_phc_test_posthog`);
});

// The SDK, once loaded, is asked first; what posthog-js stored is the answer only before it has.
test("the page names the commit it was built from, and the replay id the loaded SDK gives ahead of what it stored", async () => {
    sessionStorage.setItem(`ph_phc_test_posthog`, JSON.stringify({ $sesid: [1, `stored-session`, 0] }));
    liveReplay = `live-session`;
    // Under bun, import.meta.env reads the process environment, which stands in for vite's define here.
    process.env[`BUILD_COMMIT`] = `abc1234`;
    const { reportClient } = await load();
    reportClient(`vue.render`, `first`);
    await advanceTimersByTimeAsync(5_000);
    expect(batch().page).toMatchObject({ replay: `live-session`, commit: `abc1234` });
    liveReplay = undefined;
    delete process.env[`BUILD_COMMIT`];
    sessionStorage.removeItem(`ph_phc_test_posthog`);
});

test("an error reported just after a daemon call failed names that call", async () => {
    const { reportClient } = await load();
    await trackPerf(`rpc.request`, { path: `/conversations/x`, requestId: `req-42` }, async () => new Response(`{}`, { status: 502 }));
    reportClient(`unhandled.rejection`, `SandboxHttpError: bad gateway`);
    // A warning is not charged to it: only errors are the kind a failed call explains.
    reportClient(`perf.slow`, `slow rpc.request`, { level: `warn` });
    await advanceTimersByTimeAsync(5_000);

    expect(batch().events[0]?.fields).toMatchObject({
        lastFailedRequestId: `req-42`,
        lastFailedPath: `/conversations/x`,
        lastFailedOutcome: `HTTP 502`,
    });
    expect(batch().events[1]?.fields).toBeUndefined();
});

test("an error event with no Error behind it is still reported, with where it came from", async () => {
    const { reportWindowError } = await load();
    reportWindowError(new ErrorEvent(`error`, { message: `Script error.`, filename: `https://cdn.example/x.js`, lineno: 3, colno: 7 }));
    await advanceTimersByTimeAsync(5_000);

    expect(batch().events[0]).toMatchObject({
        event: `window.error`,
        message: `Script error.`,
        fields: { noErrorObject: true, filename: `https://cdn.example/x.js`, line: 3, column: 7 },
    });
});

test("a script that failed to load is reported by its address, without the query", async () => {
    const { reportWindowError } = await load();
    const script = document.createElement(`script`);
    script.src = `https://app.example/assets/chunk-abc.js?token=secret`;
    const event = new Event(`error`);
    Object.defineProperty(event, `target`, { value: script });
    reportWindowError(event);
    await advanceTimersByTimeAsync(5_000);

    expect(batch().events[0]).toMatchObject({ event: `resource.error`, level: `warn`, fields: { tag: `script`, url: `https://app.example/assets/chunk-abc.js` } });
});

test("distinct errors are not coalesced into each other", async () => {
    const { reportClient } = await load();
    reportClient(`vue.render`, `first`);
    reportClient(`vue.render`, `second`);
    await advanceTimersByTimeAsync(5_000);

    expect((fetched[0]?.body as { events: unknown[] } | undefined)?.events).toHaveLength(2);
});

test("with no sandbox addressed the report is dropped rather than queued forever", async () => {
    const { reportClient } = await load();
    currentTarget = undefined;
    reportClient(`window.error`, `on the sign-in screen`);
    await advanceTimersByTimeAsync(5_000);

    // The sign-in screens have nowhere to report to. Keeping these would mean a queue that only ever grows.
    expect(fetched).toHaveLength(0);
});

test("reporting cannot throw, whatever it is handed", async () => {
    const { reportClient } = await load();
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;

    // Called from an error handler: a reporter that throws turns one bug into two.
    expect(() => reportClient(`window.error`, `x`, { fields: circular as never })).not.toThrow();
    await advanceTimersByTimeAsync(5_000);
    // The report is dropped, not sent half-formed: not-throwing alone wouldn't prove that, since the flush settling
    // either way satisfies it. The queue drains and nothing posts, so the caller's error stays the only one to handle.
    expect(fetched).toHaveLength(0);
});

test("an empty queue posts nothing", async () => {
    const { flushClientDiagnostics } = await load();
    flushClientDiagnostics();
    await advanceTimersByTimeAsync(0);
    expect(fetched).toHaveLength(0);
});

test("describeError keeps the stack, which is the half that names anything", async () => {
    const { describeError } = await load();
    const error = new TypeError(`Cannot read properties of undefined`);

    const described = describeError(error);
    expect(described.message).toContain(error.name);
    expect(described.message).toContain(error.message);
    // The message alone names nothing; the first frames are the entire difference between a report and a shrug.
    expect(described.fields["stack"]).toContain(`TypeError`);
    // A thrown non-Error still says something rather than nothing.
    expect(describeError(`just a string`).message).toBe(`just a string`);
});
