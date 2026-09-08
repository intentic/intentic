import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { SafetyLogEntry } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { excerptProgram, fileSafetyLog } from "./safety-log.js";

const log = async () => {
    const dir = await mkdtemp(join(tmpdir(), "safety-log-"));
    const path = join(dir, "safety-log.json");
    return { path, log: fileSafetyLog(path) };
};

const entry = (over: Partial<SafetyLogEntry> = {}): SafetyLogEntry => ({
    at: 1_000,
    program: "rm -rf build",
    classes: ["files.destructive"],
    decision: "allow",
    sentence: "Deletes the build directory.",
    outcome: "allowed",
    ...over,
});

test("reads back newest first, which is the only order anybody scans a log in", async () => {
    const { log: safety } = await log();
    await safety.record(entry({ at: 1 }));
    await safety.record(entry({ at: 3 }));
    await safety.record(entry({ at: 2 }));
    expect((await safety.recent()).map((row) => row.at)).toEqual([3, 2, 1]);
});

// Written when reached, amended when answered, since a turn stopped while a card is up would otherwise leave no record
// at all.
test("amends the card entry with how it was answered", async () => {
    const { log: safety } = await log();
    await safety.record(entry({ at: 5, decision: "ask", outcome: "asked" }));
    await safety.answered(5, "declined", "refused");
    expect(await safety.recent()).toMatchObject([{ at: 5, outcome: "refused", answer: "declined" }]);
});

// `Date.now()` repeats routinely within one turn; amending by timestamp alone would rewrite a neighbour as though the
// owner had declined a command that actually ran.
test("an answer amends only the card, never a neighbour judged in the same millisecond", async () => {
    const { log: safety } = await log();
    const neighbour = entry({ at: 7, decision: "allow", outcome: "allowed", program: "rm -rf dist" });
    await safety.record(neighbour);
    await safety.record(entry({ at: 7, decision: "ask", outcome: "asked", program: "rm -rf build" }));
    await safety.answered(7, "declined", "refused");
    const rows = await safety.recent();
    // Whole-object equality: the neighbour must come back with `answer` absent, not merely undefined, or it would read
    // as declined.
    expect(rows.find((row) => row.program === "rm -rf dist")).toEqual(neighbour);
    expect(rows.find((row) => row.program === "rm -rf build")).toEqual(
        entry({ at: 7, decision: "ask", outcome: "refused", answer: "declined", program: "rm -rf build" }),
    );
});

// Nothing reads this log back to decide anything, so it trims to what a page can render rather than growing forever.
test("keeps the most recent entries and drops the oldest", async () => {
    const { log: safety } = await log();
    for (let at = 1; at <= 205; at += 1) {
        await safety.record(entry({ at }));
    }
    const rows = await safety.recent();
    expect(rows).toHaveLength(200);
    expect(rows.at(0)?.at).toBe(205);
    expect(rows.at(-1)?.at).toBe(6);
});

// Evidence, so a row from a newer build drops itself rather than taking a week of the log with it.
test("an unreadable file reads as an empty log rather than throwing", async () => {
    const { path, log: safety } = await log();
    await writeFile(path, `{"not":"an array"}`, "utf8");
    expect(await safety.recent()).toEqual([]);
});

// The whole program is in the transcript beside the tool call either way, so the log holds an excerpt rather than a
// second copy of everything it ran.
test("a long program is excerpted, and says how much it dropped", () => {
    const short = "rm -rf build";
    expect(excerptProgram(short)).toBe(short);
    const long = "x".repeat(500);
    expect(excerptProgram(long)).toBe(`${"x".repeat(300)}… (200 more characters)`);
});
