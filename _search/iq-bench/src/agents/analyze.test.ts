import { describe, it, expect } from "bun:test";
import { analyzeEvents, toolEvents } from "./analyze.js";

const assistant = (blocks: Array<{ name: string; command?: string }>): string =>
    JSON.stringify({
        type: "assistant",
        message: {
            content: blocks.map((block) => ({
                type: "tool_use",
                name: block.name,
                input: block.command !== undefined ? { command: block.command } : {},
            })),
        },
    });

describe("toolEvents", () => {
    it("classifies bash by command head across segments, iq with call detail", () => {
        const transcript = [
            JSON.stringify({ type: "system", subtype: "init" }),
            assistant([{ name: "Bash", command: 'iq ask "where is the budget enforced?" --budget 800' }]),
            assistant([{ name: "Bash", command: "cd /work && grep -rn foo src | head -5" }]),
            assistant([{ name: "Bash", command: "./node_modules/.bin/vitest run src/x.test.ts" }]),
            assistant([{ name: "Read" }, { name: "Edit" }]),
            "not json",
        ].join("\n");
        const events = toolEvents(transcript);
        expect(events.map((event) => event.category)).toEqual(["iq", "search", "test", "read", "edit"]);
        expect(events[0]?.iqCall).toBe('ask "where is the budget enforced?" --budget 800');
    });

    it("flags iq zero-hits and usage errors from tool results", () => {
        const use = JSON.stringify({
            type: "assistant",
            message: { content: [{ type: "tool_use", id: "t1", name: "Bash", input: { command: "iq find foo --lang ts" } }] },
        });
        const result = JSON.stringify({
            type: "user",
            message: {
                content: [{ type: "tool_result", tool_use_id: "t1", content: [{ type: "text", text: "iq: find foo — 0 matches in 0 files" }] }],
            },
        });
        const events = toolEvents([use, result].join("\n"));
        expect(events[0]?.iqZeroHit).toBe(true);
        expect(analyzeEvents(events).iqZeroHits).toBe(1);
    });

    it("classifies probes and runner heads", () => {
        const events = toolEvents(
            assistant([
                { name: "Bash", command: "node -e 'console.log(1)'" },
                { name: "Bash", command: "npx vitest run" },
            ]),
        );
        expect(events.map((event) => event.category)).toEqual(["probe", "test"]);
    });

    it("does not credit an unproven conditional iq fallback as adoption", () => {
        const events = toolEvents(
            [
                assistant([{ name: "Bash", command: "rg needle src || iq find needle" }]),
                assistant([{ name: "Bash", command: "iq find needle || rg needle src" }]),
                assistant([{ name: "Bash", command: "rg needle src || iq find needle; iq files widget" }]),
            ].join("\n"),
        );
        expect(events.map((entry) => entry.category)).toEqual(["search", "iq", "iq"]);
        expect(events.map((entry) => entry.iqCall)).toEqual([undefined, "find needle", "files widget"]);
    });

    it("counts the numbered lines a Read RESULT returned, not what it asked for", () => {
        const use = JSON.stringify({
            type: "assistant",
            message: { content: [{ type: "tool_use", id: "r1", name: "Read", input: { file_path: "src/app.ts" } }] },
        });
        const body = ["     1\timport x from 'x';", "     2\t", "     3\texport const go = () => x();"].join("\n");
        const result = JSON.stringify({
            type: "user",
            message: { content: [{ type: "tool_result", tool_use_id: "r1", content: [{ type: "text", text: body }] }] },
        });
        const events = toolEvents(`${use}\n${result}`);
        expect(events[0]?.sourceLines).toBe(3);
        const analytics = analyzeEvents(events);
        expect(analytics).toMatchObject({ readLines: 3, readCalls: 1, iqLines: 0 });
    });

    it("counts iq's own code lines apart from Read, so a win cannot come from moving the cost", () => {
        const use = JSON.stringify({
            type: "assistant",
            message: { content: [{ type: "tool_use", id: "q1", name: "Bash", input: { command: "iq def go" } }] },
        });
        // The capsule and the `… more` footer are not code and must not count.
        const answer = [
            "iq: def go, 1 definitions in 1 files",
            "answer: src/app.ts:3 · [def]",
            "════ src/app.ts (1) ════",
            "  3: export const go = () => x();",
            "  4:     return x;",
            "     … 4 more: iq context src/app.ts:5",
        ].join("\n");
        const result = JSON.stringify({
            type: "user",
            message: { content: [{ type: "tool_result", tool_use_id: "q1", content: [{ type: "text", text: answer }] }] },
        });
        const analytics = analyzeEvents(toolEvents(`${use}\n${result}`));
        expect(analytics).toMatchObject({ iqLines: 2, readLines: 0, readCalls: 0 });
    });

    it("leaves lines unmeasured when a call never returned", () => {
        const use = JSON.stringify({
            type: "assistant",
            message: { content: [{ type: "tool_use", id: "cut", name: "Read", input: { file_path: "src/app.ts" } }] },
        });
        const events = toolEvents(use);
        expect(events[0]?.sourceLines).toBeUndefined();
        expect(analyzeEvents(events).readCalls).toBe(0);
    });

    it.each([
        "No flag registered for --top",
        'Too many arguments starting with "--max"',
        "Failed to parse value for --mode",
        "Expected argument for --limit",
        'path not found in the workspace: "/outside"',
    ])("recognizes current iq usage errors: %s", (message) => {
        const use = JSON.stringify({
            type: "assistant",
            message: { content: [{ type: "tool_use", id: "bad", name: "Bash", input: { command: "iq find foo --top 3" } }] },
        });
        const result = JSON.stringify({
            type: "user",
            message: { content: [{ type: "tool_result", tool_use_id: "bad", content: message }] },
        });
        expect(toolEvents(`${use}\n${result}`)[0]?.iqUsageError).toBe(true);
    });
});

const event = (category: "iq" | "search" | "read" | "probe" | "test" | "git" | "edit" | "other"): { tool: string; category: typeof category } => ({
    tool: "Bash",
    category,
});

describe("analyzeEvents", () => {
    it("counts reads-after-iq and reads-after-search separately", () => {
        const analytics = analyzeEvents([event("iq"), event("read"), event("search"), event("read"), event("read")]);
        expect(analytics.readsAfterIq).toBe(1);
        expect(analytics.readsAfterSearch).toBe(1);
    });

    it("detects thrash bursts of ≥3 search/probe calls", () => {
        const analytics = analyzeEvents([event("search"), event("probe"), event("search"), event("read"), event("search"), event("search")]);
        expect(analytics.thrashBursts).toBe(1);
        const long = analyzeEvents([event("search"), event("search"), event("search"), event("search"), event("edit")]);
        expect(long.thrashBursts).toBe(1);
    });

    it("ignores 'other' events for adjacency", () => {
        const analytics = analyzeEvents([event("iq"), event("other"), event("read")]);
        expect(analytics.readsAfterIq).toBe(1);
    });
});
