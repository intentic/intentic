import { describe, expect, it } from "vitest";
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
