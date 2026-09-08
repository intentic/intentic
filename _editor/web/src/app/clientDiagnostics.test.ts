import { beforeEach, expect, test, vi } from "vitest";

// Pins the module's three promises to its callers (an error handler, an unload hook, a perf recorder): it never
// throws, never blocks, and never grows unbounded while the thing it's describing is still going wrong.

const target = { base: `https://sandbox.example`, connectToken: undefined };
const fetched: { body: unknown; keepalive: boolean | undefined }[] = [];

vi.mock(`../features/sandbox/client/sandboxTarget`, () => ({ currentSandboxTarget: () => currentTarget }));
vi.mock(`../features/sandbox/client/sandboxAuthFetch`, () => ({
    sandboxAuthenticatedFetch: async (request: Request) => {
        fetched.push({ body: JSON.parse(await request.clone().text()), keepalive: (request as Request & { keepalive?: boolean }).keepalive });
        return new Response(`{}`);
    },
}));
vi.mock(`./buildEpoch`, () => ({ buildId: () => `test-build` }));

let currentTarget: typeof target | undefined = target;

const load = async () => {
    vi.resetModules();
    fetched.length = 0;
    currentTarget = target;
    return import(`./clientDiagnostics`);
};

beforeEach(() => {
    vi.useFakeTimers();
});

test("a report is batched, then posted with the page's route and build", async () => {
    const { reportClient } = await load();
    reportClient(`vue.render`, `TypeError: x is undefined`, { fields: { stack: `at render` } });

    // Nothing yet: batching is what keeps a burst from being a burst of requests.
    expect(fetched).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(5_000);

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
    await vi.advanceTimersByTimeAsync(0);

    // An ordinary fetch issued before `location.reload()` would be cancelled with the page; keepalive is why the
    // self-heal report survives.
    expect(fetched[0]?.keepalive).toBe(true);
});

test("a component looping on the same error sends a few reports and a count, not a flood", async () => {
    const { reportClient } = await load();
    for (let index = 0; index < 400; index++) {
        reportClient(`vue.render`, `the same error every frame`);
    }
    await vi.advanceTimersByTimeAsync(5_000);

    const events = (fetched[0]?.body as { events: { event: string; fields?: { repeat?: number } }[] } | undefined)?.events ?? [];
    // Five of the real thing, plus the line that says what was thrown away.
    expect(events.filter((entry) => entry.event === `vue.render`)).toHaveLength(5);
    expect(events.at(-1)?.event).toBe(`client.dropped`);
    // The repeat count is what carries the information the dropped copies would have.
    expect(events[4]?.fields?.repeat).toBe(5);
});

test("distinct errors are not coalesced into each other", async () => {
    const { reportClient } = await load();
    reportClient(`vue.render`, `first`);
    reportClient(`vue.render`, `second`);
    await vi.advanceTimersByTimeAsync(5_000);

    expect((fetched[0]?.body as { events: unknown[] } | undefined)?.events).toHaveLength(2);
});

test("with no sandbox addressed the report is dropped rather than queued forever", async () => {
    const { reportClient } = await load();
    currentTarget = undefined;
    reportClient(`window.error`, `on the sign-in screen`);
    await vi.advanceTimersByTimeAsync(5_000);

    // The sign-in screens have nowhere to report to. Keeping these would mean a queue that only ever grows.
    expect(fetched).toHaveLength(0);
});

test("reporting cannot throw, whatever it is handed", async () => {
    const { reportClient } = await load();
    const circular: Record<string, unknown> = {};
    circular["self"] = circular;

    // Called from an error handler: a reporter that throws turns one bug into two.
    expect(() => reportClient(`window.error`, `x`, { fields: circular as never })).not.toThrow();
    await vi.advanceTimersByTimeAsync(5_000);
    // The report is dropped, not sent half-formed: not-throwing alone wouldn't prove that, since the flush settling
    // either way satisfies it. The queue drains and nothing posts, so the caller's error stays the only one to handle.
    expect(fetched).toHaveLength(0);
});

test("an empty queue posts nothing", async () => {
    const { flushClientDiagnostics } = await load();
    flushClientDiagnostics();
    await vi.advanceTimersByTimeAsync(0);
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
