import { QueryClient } from "@tanstack/vue-query";

// A read that never answers is the one a slow span can never name, since the span is filed when the call ends. Pins
// that such a read is reported once, past its budget, and that an answered or offline one is not.

const reports: { event: string; message: string; fields?: Record<string, unknown> }[] = [];
jest.mock(`../clientDiagnostics`, () => ({
    reportClient: (event: string, message: string, options: { fields?: Record<string, unknown> } = {}) =>
        reports.push({ event, message, fields: options.fields }),
}));

const { STALLED_MS, watchStalledQueries } = await import("./queryStalls");

let clock = 0;
let stop: (() => void) | undefined;
const watched = (): QueryClient => {
    const client = new QueryClient({ defaultOptions: { queries: { retry: false } } });
    stop = watchStalledQueries(client, () => clock);
    return client;
};

beforeEach(() => {
    jest.useFakeTimers();
    reports.length = 0;
    clock = 0;
});
afterEach(() => {
    stop?.();
    jest.useRealTimers();
});

// Moves the watch's clock and its timer together, as the page's would.
const pass = (ms: number): void => {
    clock += ms;
    jest.advanceTimersByTime(ms);
};

test("a read pending past its budget is reported once, with its key", () => {
    const client = watched();
    void client.fetchQuery({ queryKey: [`conversations.list`, { scope: `all` }], queryFn: () => new Promise<never>(() => {}) });

    pass(STALLED_MS + 10_000);
    pass(60_000);

    expect(reports).toHaveLength(1);
    expect(reports[0]).toMatchObject({ event: `query.stalled`, fields: { key: `["conversations.list",{"scope":"all"}]`, hasData: false } });
    expect(Number(reports[0]?.fields?.[`pendingMs`])).toBeGreaterThanOrEqual(STALLED_MS);
});

test("a read that answers inside its budget says nothing", async () => {
    const client = watched();
    await client.fetchQuery({ queryKey: [`quick`], queryFn: () => Promise.resolve(1) });
    pass(STALLED_MS * 3);
    expect(reports).toHaveLength(0);
});
