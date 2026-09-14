import { expect, test } from "vitest";
import { DEV_REBUILD_EXIT_MARK, DEV_REBUILD_QUIET_MARK, devRebuildLogPath, readDevRebuildLog } from "./devices.js";

// The one account a detached rebuild gives of itself. The daemon builds the shell that writes this text and the browser
// draws what it means, so the grammar is pinned here, where both of them read it.

// Exactly what the machine's shell prints: the quiet header first, then the log's own tail.
const answer = (quiet: string, ...lines: readonly string[]): string => [`${DEV_REBUILD_QUIET_MARK} ${quiet}`, ...lines].join("\n");

test("reads a build still running as running, however long it has been quiet", () => {
    const log = readDevRebuildLog(answer("140", "#12 [builder 4/9] RUN pnpm install", "#12 3.402 Progress: resolved 41"));
    expect(log).toMatchObject({ missing: false, quietFor: 140, exitCode: undefined });
    expect(log.lines).toEqual(["#12 [builder 4/9] RUN pnpm install", "#12 3.402 Progress: resolved 41"]);
});

// The exit mark is written by the build's own shell, and is the only thing that ends a rebuild: without it, a build
// inside a slow docker layer and a build whose machine went to sleep print exactly the same thing.
test("takes the exit mark as the end, and its status as the outcome", () => {
    expect(readDevRebuildLog(answer("2", "done", `${DEV_REBUILD_EXIT_MARK} 0`)).exitCode).toBe(0);
    expect(readDevRebuildLog(answer("2", "boom", `${DEV_REBUILD_EXIT_MARK} 137`)).exitCode).toBe(137);
    // A status that isn't a number still means the build ENDED, and not well.
    expect(readDevRebuildLog(answer("2", `${DEV_REBUILD_EXIT_MARK} ?`)).exitCode).toBe(1);
});

test("keeps the marks out of the lines it hands back", () => {
    const log = readDevRebuildLog(answer("0", "step one", "step two", `${DEV_REBUILD_EXIT_MARK} 0`));
    expect(log.lines).toEqual(["step one", "step two"]);
});

// `-` is the shell's own word for a log that is not there: nothing has ever rebuilt this sandbox from a checkout here.
test("tells no log at all apart from a log with nothing in it", () => {
    expect(readDevRebuildLog(answer("-"))).toMatchObject({ missing: true, quietFor: undefined, lines: [] });
    expect(readDevRebuildLog(answer("0"))).toMatchObject({ missing: false, lines: [] });
});

// `stat` answers in two dialects and a machine may run neither; an unreadable mtime must not read as "just grew".
test("leaves the quiet time unknown rather than guessing when the machine won't say", () => {
    expect(readDevRebuildLog(answer("?", "building")).quietFor).toBeUndefined();
    expect(readDevRebuildLog(answer("?", "building")).missing).toBe(false);
});

test("drops the blank tail the exit mark's own leading newline leaves behind", () => {
    // printf writes "\n@mark 0\n", so the line before the mark is empty and the line after it is too.
    expect(readDevRebuildLog(answer("0", "last real line", "", `${DEV_REBUILD_EXIT_MARK} 0`, "")).lines).toEqual(["last real line"]);
});

// Nothing this reads is trusted to be a mark: an answer that lost its header is a log with nothing to say yet.
test("treats an answer with no marks as log text, not as an error", () => {
    expect(readDevRebuildLog("just some output\n")).toMatchObject({ missing: false, quietFor: undefined, exitCode: undefined });
    expect(readDevRebuildLog("").lines).toEqual([]);
});

test("names one log per sandbox, beside the logs ic writes for its own recreates", () => {
    expect(devRebuildLogPath("work-abc")).toBe("~/.intentic/logs/dev-rebuild-work-abc.log");
});
