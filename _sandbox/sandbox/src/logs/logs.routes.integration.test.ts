import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pino } from "pino";
import type { Logger } from "pino";
import { createLogsRoutes } from "./logs.routes.js";

// Pins the framing, not just the write: a browser's report of itself must say so (`client: true`) and never overwrite
// the frame the daemon puts around it.

const capturing = (): { logger: Logger; lines: Record<string, unknown>[] } => {
    const lines: Record<string, unknown>[] = [];
    const logger: Logger = pino({ level: "warn", messageKey: "message" }, { write: (line: string) => lines.push(JSON.parse(line)) });
    return { logger, lines };
};

const event = (over: Record<string, unknown> = {}) => ({
    seenAt: 1_700_000_000_000,
    level: "error" as const,
    event: "vue.render-function",
    message: "TypeError: x is undefined",
    ...over,
});

type Budget = NonNullable<Parameters<typeof createLogsRoutes>[1]>["budget"];

const routes = (clientLogger: Logger | undefined, budget?: Budget) =>
    createLogsRoutes(
        { config: { historyRoot: mkdtempSync(join(tmpdir(), "logs-routes-")) } as never, clientLogger },
        budget !== undefined ? { budget } : {},
    );

type Reporter = (events: readonly Record<string, unknown>[], page?: Record<string, unknown>) => Promise<{ recorded: number }>;

// Invokes the handler oRPC's `.handler()` returns, the actual call target, so the contract's own validation stays in
// the loop. One router per reporter, so a budget carries across its calls as it does across a page's batches.
const reporter = (clientLogger: Logger | undefined, budget?: Budget): Reporter => {
    const procedure = routes(clientLogger, budget).report as unknown as { "~orpc": { handler: (options: { input: unknown }) => unknown } };
    return async (events, page) => (await procedure["~orpc"].handler({ input: { events, page } })) as { recorded: number };
};

const report = (clientLogger: Logger | undefined, events: readonly Record<string, unknown>[]): Promise<{ recorded: number }> =>
    reporter(clientLogger)(events);

test("a browser report is written at its own level and marked as the browser's word", async () => {
    const sink = capturing();
    expect(await report(sink.logger, [event()])).toEqual({ recorded: 1 });

    expect(sink.lines).toHaveLength(1);
    expect(sink.lines[0]).toMatchObject({
        // `client: true` marks this as the browser's own account, distinct from the daemon's.
        client: true,
        level: 50,
        event: "vue.render-function",
        message: "TypeError: x is undefined",
        seenAt: 1_700_000_000_000,
    });
});

test("a warn-level report is kept, even though the daemon's own log level might drop it", async () => {
    const sink = capturing();
    await report(sink.logger, [event({ level: "warn", event: "perf.slow", message: "slow chat.frame 48ms" })]);
    expect(sink.lines[0]).toMatchObject({ level: 40, event: "perf.slow" });
});

test("what the page sent rides under `report`, so it cannot overwrite the frame the daemon put around it", async () => {
    const sink = capturing();
    await report(sink.logger, [
        event({
            route: "/agents",
            requestId: "req-7",
            build: "abc123",
            // These field names collide with the daemon's own top-level names; nesting must prevent the overwrite.
            fields: { level: "info", message: "not the message", stack: "at render (App.vue:1)" },
        }),
    ]);

    const line = sink.lines[0] ?? {};
    expect(line["level"]).toBe(50);
    expect(line["message"]).toBe("TypeError: x is undefined");
    expect(line["report"]).toMatchObject({ route: "/agents", requestId: "req-7", build: "abc123", level: "info", stack: "at render (App.vue:1)" });
});

test("a batch is written whole, in the order the browser saw it", async () => {
    const sink = capturing();
    expect(await report(sink.logger, [event({ message: "first" }), event({ message: "second" }), event({ message: "third" })])).toEqual({
        recorded: 3,
    });
    expect(sink.lines.map((line) => line["message"])).toEqual(["first", "second", "third"]);
});

test("the page stamp rides on every line, so a reader filtering one line at a time can still tell two tabs apart", async () => {
    const sink = capturing();
    const page = { pageId: "p-1", tabId: "t-1", replay: "ph-session", served: "dev /work/intentic@main" };
    await reporter(sink.logger)([event({ message: "first" }), event({ message: "second" })], page);

    expect(sink.lines.map((line) => line["page"])).toEqual([page, page]);
});

test("a page over its per-minute budget is cut off, and the next batch that gets through says how many were refused", async () => {
    const sink = capturing();
    let now = 0;
    const send = reporter(sink.logger, { perKeyPerWindow: 3, allPerWindow: 100, windowMs: 60_000, now: () => now });
    const page = { pageId: "looping" };

    expect(await send([event(), event(), event(), event(), event()], page)).toEqual({ recorded: 3 });
    expect(await send([event()], page)).toEqual({ recorded: 0 });
    // Another tab is not charged for the looping one.
    expect(await send([event()], { pageId: "quiet" })).toEqual({ recorded: 1 });
    expect(sink.lines).toHaveLength(4);

    now = 60_000;
    expect(await send([event({ message: "after" })], page)).toEqual({ recorded: 1 });
    const notice = sink.lines.at(-2) ?? {};
    expect(notice).toMatchObject({ client: true, event: "client.throttled", level: 40, page, report: { refused: 3 } });
    expect(sink.lines.at(-1)?.["message"]).toBe("after");
});

test("pages that mint a new id per batch still share one ceiling", async () => {
    const sink = capturing();
    const send = reporter(sink.logger, { perKeyPerWindow: 10, allPerWindow: 4, windowMs: 60_000, now: () => 0 });
    let total = 0;
    for (let index = 0; index < 5; index++) {
        total += (await send([event(), event()], { pageId: `minted-${index}` })).recorded;
    }
    expect(total).toBe(4);
});

test("with nowhere to write, nothing is recorded and the answer says so", async () => {
    // undefined clientLogger stands in for an unwritable history root (local dev, tests).
    expect(await report(undefined, [event()])).toEqual({ recorded: 0 });
});

test("the reads still serve the daemon's own files", async () => {
    const historyRoot = mkdtempSync(join(tmpdir(), "logs-routes-"));
    const built = createLogsRoutes({ config: { historyRoot } as never, clientLogger: undefined });
    const list = built.list as unknown as { "~orpc": { handler: (options: { input: unknown }) => unknown } };
    // No files yet reads as an empty list, not a failure.
    expect(await list["~orpc"].handler({ input: {} })).toEqual({ files: [] });
    await expect(readFile(join(historyRoot, "logs", "client.jsonl"))).rejects.toThrow();
});
