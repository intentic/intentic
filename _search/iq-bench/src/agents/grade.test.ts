import { describe, expect, it } from "vitest";
import { parseClaudeStream } from "./claude.js";
import { parseCodexStream } from "./codex.js";
import { anchorHit, gradeAnchors } from "./grade.js";

describe("anchorHit", () => {
    it("matches path suffix regardless of absolute/relative prefix", () => {
        expect(anchorHit("the bug is in /work/src/click/core.py", { file: "src/click/core.py" })).toBe(true);
        expect(anchorHit("see core.py", { file: "src/click/core.py" })).toBe(false);
    });

    it("accepts :N, #LN, LN and 'line N' within tolerance, case-insensitively", () => {
        const anchor = { file: "src/compose.ts", line: 40 };
        expect(anchorHit("src/compose.ts:42", anchor)).toBe(true);
        expect(anchorHit("src/compose.ts#L38", anchor)).toBe(true);
        expect(anchorHit("src/compose.ts (line 45)", anchor)).toBe(true);
        expect(anchorHit("src/compose.ts, lines 41-50", anchor)).toBe(true);
        expect(anchorHit("**`src/compose.ts`**\n- **Line 42**: the check", anchor)).toBe(true);
        expect(anchorHit("src/compose.ts:400", anchor)).toBe(false);
        expect(anchorHit("src/compose.ts is relevant", anchor)).toBe(false);
    });

    it("respects explicit tolerance", () => {
        expect(anchorHit("a/b.ts:60", { file: "a/b.ts", line: 40, tolerance: 5 })).toBe(false);
        expect(anchorHit("a/b.ts:44", { file: "a/b.ts", line: 40, tolerance: 5 })).toBe(true);
    });

    it("checks every occurrence of the path, not just the first", () => {
        expect(anchorHit("a/b.ts is big. answer: a/b.ts:41", { file: "a/b.ts", line: 40 })).toBe(true);
    });
});

describe("gradeAnchors", () => {
    const anchors = [{ file: "x/one.ts" }, { file: "x/two.ts" }];

    it("any-of by default, all-of with requireAll", () => {
        expect(gradeAnchors("found x/one.ts", { anchors }).success).toBe(true);
        expect(gradeAnchors("found x/one.ts", { anchors, requireAll: true }).success).toBe(false);
        expect(gradeAnchors("x/one.ts and x/two.ts", { anchors, requireAll: true }).success).toBe(true);
    });

    it("details every anchor verdict", () => {
        expect(gradeAnchors("found x/one.ts", { anchors }).detail).toBe("✓ x/one.ts, ✗ x/two.ts");
    });
});

describe("parseClaudeStream", () => {
    it("extracts the final result event", () => {
        const stdout = [
            JSON.stringify({ type: "system", subtype: "init" }),
            JSON.stringify({ type: "assistant", message: {} }),
            JSON.stringify({
                type: "result",
                result: "the answer",
                total_cost_usd: 0.12,
                num_turns: 7,
                usage: { input_tokens: 100, output_tokens: 50, cache_read_input_tokens: 4000, cache_creation_input_tokens: 900 },
            }),
        ].join("\n");
        expect(parseClaudeStream(stdout)).toEqual({
            answer: "the answer",
            turns: 7,
            tokensIn: 5000,
            tokensOut: 50,
            cacheReadTokens: 4000,
            costUsd: 0.12,
        });
    });

    it("returns empty answer when no result event exists (timeout kill)", () => {
        expect(parseClaudeStream('{"type":"assistant"}\ngarbage')).toEqual({ answer: "" });
    });
});

describe("parseCodexStream", () => {
    it("accumulates turns and usage, keeps the last agent message", () => {
        const stdout = [
            JSON.stringify({ type: "item.completed", item: { type: "command_execution", text: "ls" } }),
            JSON.stringify({ type: "turn.completed", usage: { input_tokens: 1000, cached_input_tokens: 300, output_tokens: 20 } }),
            JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "draft" } }),
            JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "final answer" } }),
            JSON.stringify({ type: "turn.completed", usage: { input_tokens: 2000, cached_input_tokens: 500, output_tokens: 30 } }),
        ].join("\n");
        expect(parseCodexStream(stdout)).toEqual({
            answer: "final answer",
            turns: 2,
            tokensIn: 3000,
            tokensOut: 50,
            cacheReadTokens: 800,
        });
    });

    it("leaves metrics absent when events carry none", () => {
        expect(parseCodexStream(JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "hi" } }))).toEqual({ answer: "hi" });
    });
});
