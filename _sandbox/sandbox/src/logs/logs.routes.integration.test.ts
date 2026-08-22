import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { pino } from "pino";
import type { Logger } from "pino";
import { createLogsRoutes } from "./logs.routes.js";

/* THE ONE WRITE ON THE LOGS ROUTER, and the record of a failure nothing daemon-side can witness.
 *
 * What these pin is the framing as much as the writing. This file is a browser's account of ITSELF, arriving over
 * a route anyone signed in can post to, while every other log here is trustworthy precisely because only the
 * daemon writes it. So each line has to say what it is, and nothing a page chooses to send may overwrite the
 * frame the daemon puts around it. */

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

const routes = (clientLogger: Logger | undefined) =>
    createLogsRoutes({ config: { historyRoot: mkdtempSync(join(tmpdir(), "logs-routes-")) } as never, clientLogger });

// The handler as the router invokes it. oRPC's `.handler()` returns a procedure whose implementation is what a
// call reaches; going through it keeps the contract's own validation in the loop.
const report = async (clientLogger: Logger | undefined, events: readonly Record<string, unknown>[]): Promise<{ recorded: number }> => {
    const procedure = routes(clientLogger).report as unknown as { "~orpc": { handler: (options: { input: unknown }) => unknown } };
    return (await procedure["~orpc"].handler({ input: { events } })) as { recorded: number };
};

test("a browser report is written at its own level and marked as the browser's word", async () => {
    const sink = capturing();
    expect(await report(sink.logger, [event()])).toEqual({ recorded: 1 });

    expect(sink.lines).toHaveLength(1);
    expect(sink.lines[0]).toMatchObject({
        // `client: true` is not decoration: a reader who cannot tell this from the daemon's own account would
        // eventually trust the wrong one.
        client: true,
        level: 50,
        event: "vue.render-function",
        message: "TypeError: x is undefined",
        seenAt: 1_700_000_000_000,
    });
});

test("a warn-level report is kept, even though the daemon's own log level might drop it", async () => {
    const sink = capturing();
    // The stall reports are the half that answers "the UI feels slow", and the browser has already decided they
    // are worth a round trip. A sandbox running at `error` must not silently discard them.
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
            // A page sending these top-level names is exactly the collision the nesting prevents.
            fields: { level: "info", message: "not the message", stack: "at render (App.vue:1)" },
        }),
    ]);

    const line = sink.lines[0] ?? {};
    // The daemon's own framing survived.
    expect(line["level"]).toBe(50);
    expect(line["message"]).toBe("TypeError: x is undefined");
    // …and the page's values are all there, one level down.
    expect(line["report"]).toMatchObject({ route: "/agents", requestId: "req-7", build: "abc123", level: "info", stack: "at render (App.vue:1)" });
});

test("a batch is written whole, in the order the browser saw it", async () => {
    const sink = capturing();
    expect(await report(sink.logger, [event({ message: "first" }), event({ message: "second" }), event({ message: "third" })])).toEqual({
        recorded: 3,
    });
    expect(sink.lines.map((line) => line["message"])).toEqual(["first", "second", "third"]);
});

test("with nowhere to write, nothing is recorded and the answer says so", async () => {
    // An unwritable history root (local dev, tests). A diagnostic channel failing must never be the thing that
    // breaks the page trying to report a failure, and it must not claim to have filed a report either.
    expect(await report(undefined, [event()])).toEqual({ recorded: 0 });
});

test("the reads still serve the daemon's own files", async () => {
    const historyRoot = mkdtempSync(join(tmpdir(), "logs-routes-"));
    const built = createLogsRoutes({ config: { historyRoot } as never, clientLogger: undefined });
    const list = built.list as unknown as { "~orpc": { handler: (options: { input: unknown }) => unknown } };
    // Nothing written yet: an empty list, not a failure.
    expect(await list["~orpc"].handler({ input: {} })).toEqual({ files: [] });
    await expect(readFile(join(historyRoot, "logs", "client.jsonl"))).rejects.toThrow();
});
