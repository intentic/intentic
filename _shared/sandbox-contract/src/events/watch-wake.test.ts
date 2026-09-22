import { describe, it, expect } from "bun:test";
import type { WatchOutcome } from "./transcript.js";
import { watchWakeOf, watchWakePrompt, watchWakeRow, type WatchWakeFields } from "./watch-wake.js";

const fields = (over: Partial<WatchWakeFields> = {}): WatchWakeFields => ({
    outcome: "met",
    id: "watch-2",
    note: "CI run 316 on intentic/intentic",
    elapsed: "43m",
    command: "gh run view 316 --json status",
    exitCode: 0,
    output: "completed success",
    ...over,
});

const OUTCOMES: WatchOutcome[] = ["met", "timeout", "restart-expired", "broken"];

describe("watch wake", () => {
    // The composer and the parser are the same piece of knowledge; this is what holds them together when either is
    // reworded.
    it.each(OUTCOMES)("round-trips a %s wake back to its fields", (outcome) => {
        const wake = watchWakeOf(watchWakePrompt(fields({ outcome })));
        expect(wake).toEqual({ outcome, note: "CI run 316 on intentic/intentic", elapsed: "43m", sent: expect.any(String) });
    });

    it("keeps the prompt verbatim on the row, since nobody typed it", () => {
        const prompt = watchWakePrompt(fields());
        expect(watchWakeOf(prompt)?.sent).toBe(prompt);
    });

    it("carries the watch id in the body, not the opening", () => {
        const prompt = watchWakePrompt(fields());
        expect(prompt.split("\n")[0]).not.toContain("watch-2");
        expect(prompt).toContain("Watch id: watch-2");
    });

    it("says an absent exit code in words, since the check never reported one", () => {
        expect(watchWakePrompt(fields({ exitCode: undefined }))).toContain("Last exit code: none (check was killed or failed to start)");
    });

    it("omits the output block when the check said nothing", () => {
        expect(watchWakePrompt(fields({ output: "" }))).not.toContain("Last output (tail):");
    });

    it("draws a notice row, never a user row: a watch firing is neither side speaking", () => {
        const row = watchWakeRow(watchWakePrompt(fields()));
        expect(row?.role).toBe("notice");
        expect(row?.text).toBe("CI run 316 on intentic/intentic — the watch fired after 43m.");
    });

    it("words each ending differently, since each calls for a different next step", () => {
        const textOf = (outcome: WatchOutcome): string => watchWakeRow(watchWakePrompt(fields({ outcome })))?.text ?? "";
        expect(textOf("timeout")).toBe("CI run 316 on intentic/intentic — the watch gave up after 43m.");
        expect(textOf("restart-expired")).toBe("CI run 316 on intentic/intentic — the watch stopped when the sandbox restarted, after 43m.");
        expect(textOf("broken")).toBe("CI run 316 on intentic/intentic — the watch stopped after 43m: its check can no longer run.");
    });

    it("ignores a prompt that is not a wake, so any reader can ask without checking first", () => {
        expect(watchWakeOf("fix the bug")).toBeUndefined();
        expect(watchWakeRow("Watch fired: something I typed myself")).toBeUndefined();
    });

    it("refuses a wake whose labelled lines are gone, rather than putting a blank note on the row", () => {
        const prompt = watchWakePrompt(fields());
        expect(watchWakeOf(prompt.replace("Watching: CI run 316 on intentic/intentic\n", ""))).toBeUndefined();
        expect(watchWakeOf(prompt.replace("Elapsed: 43m\n", ""))).toBeUndefined();
    });
});
