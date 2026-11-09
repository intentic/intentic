import { type Logger, pino } from "pino";
import { BUCKETS, bucketOf, HISTOGRAM_VERSION } from "./perf-histogram.js";
import {
    createRollupWindows,
    gitSubcommand,
    OTHER_SUBJECT,
    ROLLUP_WINDOW_MS,
    type RollupRow,
    rollupRowSchema,
    routeTemplate,
    spanSubject,
    startRollups,
} from "./perf-rollup.js";

// The rollup windows: what a span is filed under, how a window closes (on its boundary, at a boot that came mid-window,
// at a clean stop), and that a window's rows stay bounded however many subjects it saw.

const T = (time: string): number => Date.parse(`2026-11-06T${time}Z`);

const clock = (start: number) => {
    let now = start;
    return { now: () => now, set: (time: number) => void (now = time) };
};

// Route names without digits or hyphens, so none of them is folded as an id: a, b, …, z, ba, bb, ….
const letters = (n: number): string => (n < 26 ? String.fromCodePoint(97 + n) : `${letters(Math.floor(n / 26))}${letters(n % 26)}`);

// Collects the messages warned, nothing else. Explicit `Logger` type works around pino's widened return under
// exactOptionalPropertyTypes.
const warnings = () => {
    const messages: string[] = [];
    const logger: Logger = pino({ level: "warn", messageKey: "message" }, { write: (line: string) => void messages.push(String(JSON.parse(line).message)) });
    return { logger, messages };
};

const rowsOf = (text: string): RollupRow[] =>
    text
        .split("\n")
        .filter((line) => line !== "")
        .map((line) => rollupRowSchema.parse(JSON.parse(line)));

test("a request is filed under its route, with ids, conversation ids and the query folded out", () => {
    expect(routeTemplate("GET", "/agents/keen-pine-tkjf/diff")).toBe("GET /agents/:id/diff");
    expect(routeTemplate("GET", "/agents/otter-kmpq/diff")).toBe("GET /agents/:id/diff");
    expect(routeTemplate("GET", "/agents/linked-otter-kmpq/diff")).toBe("GET /agents/:id/diff");
    expect(routeTemplate("GET", "/agents/git-view")).toBe("GET /agents/git-view");
    expect(routeTemplate("POST", "/system/devices/rog::wsl:archlinux1/commands/dev-rebuild-log")).toBe("POST /system/devices/:id/commands/dev-rebuild-log");
    expect(routeTemplate("GET", "/settings/ai-literacy/en?x=1")).toBe("GET /settings/ai-literacy/en");
    expect(routeTemplate(undefined, "text")).toBe("text");
});

test("a git span is filed under its subcommand, past any global option", () => {
    expect(gitSubcommand("--no-optional-locks status --porcelain=v2")).toBe("status");
    expect(gitSubcommand("ls-files --others --exclude-standard")).toBe("ls-files");
    expect(spanSubject({ git: "diff --name-only --no-renames", repo: "intentic" })).toBe("diff");
});

test("a span's subject is its route, else its git subcommand, else its tool, role, rule or frame, else none", () => {
    expect(spanSubject({ method: "GET", path: "/chores", status: 200 })).toBe("GET /chores");
    expect(spanSubject({ matcher: "Bash", at: 3, tool: "Bash", conversation: "solid-heron-n92g" })).toBe("Bash");
    expect(spanSubject({ role: "session-title", provider: "claude" })).toBe("session-title");
    expect(spanSubject({ rule: "repo-check-intentic-1", status: "passed" })).toBe("repo-check-intentic-1");
    expect(spanSubject({ frame: "agents", depth: 0 })).toBe("agents");
    expect(spanSubject({ repo: "intentic" })).toBeUndefined();
});

test("a boot mid-window writes that window from the boot on, and every window after it in full", () => {
    const time = clock(T("11:04:30.000"));
    const windows = createRollupWindows(time.now);
    windows.add("git.run", 10, { git: "status" }, false);
    windows.add("git.run", 30, { git: "status" }, true);
    windows.add("turn.plan.deps", 2, {}, false);
    expect(windows.endsAt()).toBe(T("11:10:00.000"));

    time.set(T("11:10:00.004"));
    const first = rowsOf(windows.flush("boundary"));
    expect(first.map((row) => [row.op, row.subject, row.count, row.at, row.from, row.to])).toEqual([
        ["git.run", "status", 2, "2026-11-06T11:00:00.000Z", "2026-11-06T11:04:30.000Z", undefined],
        ["turn.plan.deps", undefined, 1, "2026-11-06T11:00:00.000Z", "2026-11-06T11:04:30.000Z", undefined],
    ]);
    expect(first[0]).toMatchObject({ totalMs: 40, failed: 1, maxMs: 30, v: HISTOGRAM_VERSION, b0: bucketOf(10) });
    expect(first[0]?.b.reduce((total, count) => total + count, 0)).toBe(2);

    windows.add("git.run", 20, { git: "status" }, false);
    time.set(T("11:20:00.001"));
    const second = rowsOf(windows.flush("boundary"));
    expect(second).toHaveLength(1);
    expect(second[0]).toMatchObject({ at: "2026-11-06T11:10:00.000Z", count: 1, p50: 20, p99: 20, maxMs: 20 });
    expect(second[0]).not.toHaveProperty("from");
    expect(second[0]).not.toHaveProperty("to");
    // A window counted in full carries no failures field at all.
    expect(second[0]).not.toHaveProperty("failed");
});

test("a clean stop writes the window counted so far, marked with when it stopped", () => {
    const time = clock(T("11:10:00.000"));
    const windows = createRollupWindows(time.now);
    windows.add("http.request", 120, { method: "GET", path: "/chores" }, false);
    time.set(T("11:13:20.000"));

    const rows = rowsOf(windows.flush("stop"));
    expect(rows).toEqual([expect.objectContaining({ at: "2026-11-06T11:10:00.000Z", subject: "GET /chores", to: "2026-11-06T11:13:20.000Z" })]);
    expect(rows[0]).not.toHaveProperty("from");
    // Nothing left to write: a second stop adds nothing.
    expect(windows.flush("stop")).toBe("");
});

test("a window nothing was counted in writes nothing, and an op idle for a window gets no row of zeroes", () => {
    const time = clock(T("11:00:00.000"));
    const windows = createRollupWindows(time.now);
    windows.add("devices.pull", 3_000, { id: "rog" }, false);
    time.set(T("11:10:00.000"));
    expect(rowsOf(windows.flush("boundary")).map((row) => row.op)).toEqual(["devices.pull"]);
    time.set(T("11:20:00.000"));
    expect(windows.flush("boundary")).toBe("");
});

test("a timer that wakes a window late marks the row with when it was written", () => {
    const time = clock(T("11:00:00.000"));
    const windows = createRollupWindows(time.now);
    windows.add("git.scan", 800, {}, false);
    // Suspended across a whole window: the row keeps its own window's start, and says how far it ran.
    time.set(T("11:25:00.000"));
    expect(rowsOf(windows.flush("boundary"))[0]).toMatchObject({ at: "2026-11-06T11:00:00.000Z", to: "2026-11-06T11:25:00.000Z" });
    windows.add("git.scan", 800, {}, false);
    time.set(T("11:30:00.000"));
    expect(rowsOf(windows.flush("boundary"))[0]).toMatchObject({ at: "2026-11-06T11:20:00.000Z", from: "2026-11-06T11:25:00.000Z" });
});

test("an op's rows stop at its 24 costliest subjects, the rest folded into one, so a window stays bounded", () => {
    const time = clock(T("11:00:00.000"));
    const windows = createRollupWindows(time.now);
    // 100 routes, route n costing n ms: past the 64 tracked apart, new ones count straight into the fold.
    for (let route = 1; route <= 100; route += 1) {
        windows.add("http.request", route, { method: "GET", path: `/r/${letters(route)}` }, false);
    }
    time.set(T("11:10:00.000"));
    const rows = rowsOf(windows.flush("boundary"));

    expect(rows).toHaveLength(25);
    const other = rows.find((row) => row.subject === OTHER_SUBJECT);
    // Every span is still counted: the 24 rows plus the fold hold all 100.
    expect(rows.reduce((total, row) => total + row.count, 0)).toBe(100);
    expect(other?.count).toBe(76);
    // The rows kept apart are the costliest of the 64 tracked: routes 41 to 64.
    expect(rows.filter((row) => row.subject !== OTHER_SUBJECT).map((row) => row.maxMs)).toEqual(Array.from({ length: 24 }, (_, index) => 64 - index));
    expect(other?.maxMs).toBe(100);
});

test("the rows a window writes merge back into the window's own histogram", () => {
    const time = clock(T("11:00:00.000"));
    const windows = createRollupWindows(time.now);
    const spans = [0.5, 3, 3, 40, 900];
    for (const ms of spans) {
        windows.add("edit.rule", ms, { rule: "lint" }, false);
    }
    time.set(T("11:10:00.000"));
    const [row] = rowsOf(windows.flush("boundary"));
    const counts = Array.from({ length: BUCKETS }, () => 0);
    row?.b.forEach((count, offset) => {
        counts[(row?.b0 ?? 0) + offset] = count;
    });
    expect(counts.flatMap((count, bucket) => Array.from({ length: count }, () => bucket))).toEqual(spans.map((ms) => bucketOf(ms)));
});

test("rollups are written at each boundary on the clock, and a stop writes the partial window and nothing after", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(T("11:04:00.000"));
    const written: string[] = [];
    const rollups = startRollups(async (text) => void written.push(text), warnings().logger);
    rollups.add("git.run", 5, { git: "status" }, false);

    jest.advanceTimersByTime(ROLLUP_WINDOW_MS - 4 * 60_000 - 1);
    expect(written).toEqual([]);
    jest.advanceTimersByTime(1);
    await Promise.resolve();
    rollups.add("git.run", 5, { git: "status" }, false);
    await rollups.stop();
    jest.advanceTimersByTime(ROLLUP_WINDOW_MS * 3);
    jest.useRealTimers();

    expect(written.map((text) => rowsOf(text).map((row) => [row.at, row.from, row.to]))).toEqual([
        [["2026-11-06T11:00:00.000Z", "2026-11-06T11:04:00.000Z", undefined]],
        [["2026-11-06T11:10:00.000Z", undefined, "2026-11-06T11:10:00.000Z"]],
    ]);
});

test("a window whose append fails is said once and does not stop the next one", async () => {
    jest.useFakeTimers();
    jest.setSystemTime(T("11:00:00.000"));
    const warned = warnings();
    let attempts = 0;
    const rollups = startRollups(async () => {
        attempts += 1;
        if (attempts === 1) {
            throw new Error("disk full");
        }
    }, warned.logger);
    rollups.add("git.run", 5, {}, false);
    jest.advanceTimersByTime(ROLLUP_WINDOW_MS);
    rollups.add("git.run", 5, {}, false);
    await rollups.stop();
    jest.useRealTimers();

    expect(attempts).toBe(2);
    expect(warned.messages).toEqual(["perf: a rollup window could not be written"]);
});
