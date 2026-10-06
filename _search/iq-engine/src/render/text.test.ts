import type { RankedGroup } from "../types.js";
import { estimateTokens } from "./budget.js";
import { renderText } from "./text.js";

const groups = (files: number, hitsPerFile: number): RankedGroup[] =>
    Array.from({ length: files }, (unusedFile, f) => ({
        path: `alpha/src/file-${f}.ts`,
        score: files - f,
        hits: Array.from({ length: hitsPerFile }, (unusedHit, h) => ({
            path: `alpha/src/file-${f}.ts`,
            line: h + 1,
            text: `const value${h} = computeSomething(${h}); // representative code line for budget tests`,
            tags: [{ kind: "text" as const }],
            score: 1,
        })),
    }));

const render = (input: RankedGroup[], budget: number): ReturnType<typeof renderText> =>
    renderText({
        verb: "find",
        echo: 'find "value"',
        unit: "matches",
        style: "hits",
        showTags: false,
        groups: input,
        offset: 0,
        freshness: { state: "fresh", ageMs: 120 },
        budget,
        cursorId: "abcd1234",
    });

test("hard budget: rendered output never exceeds --budget across sizes", () => {
    for (const budget of [80, 150, 300, 700, 1500, 4000]) {
        for (const [files, hits] of [
            [1, 1],
            [3, 5],
            [10, 20],
            [40, 8],
        ] as const) {
            const rendered = render(groups(files, hits), budget);
            expect(estimateTokens(rendered.text), `budget=${budget} files=${files} hits=${hits}`).toBeLessThanOrEqual(budget);
        }
    }
});

test("truncation footer carries a resumable cursor; header states shown/total", () => {
    const rendered = render(groups(30, 10), 400);
    expect(rendered.truncated).toBe(true);
    expect(rendered.cursor).toMatch(/^abcd1234[0-9a-z]+$/);
    expect(rendered.text).toContain(`--after ${rendered.cursor}`);
    expect(rendered.text).toContain("300 matches in 30 files");
});

test("zero hits: exit code 1 and an honest header", () => {
    const rendered = render([], 500);
    expect(rendered.exitCode).toBe(1);
    expect(rendered.text).toContain("0 matches in 0 files");
    expect(rendered.truncated).toBe(false);
});

test("offset pages through groups without re-counting totals", () => {
    const all = groups(6, 2);
    const first = render(all, 280);
    expect(first.truncated).toBe(true);
    const second = renderText({
        verb: "find",
        echo: 'find "value"',
        unit: "matches",
        style: "hits",
        showTags: false,
        groups: all,
        offset: first.shownGroups,
        freshness: { state: "fresh", ageMs: 120 },
        budget: 4000,
        cursorId: "abcd1234",
    });
    expect(second.text).toContain("12 matches in 6 files");
    expect(second.shownGroups).toBe(6 - first.shownGroups);
    expect(second.truncated).toBe(false);
});

// Line scores peak inside a symbol, not at its head, so the best-scoring line in a long function is routinely a
// brace or a `continue;` far below the definition the reader asked for: 31% of anchors in the 2026-09 mining.
// symctx knows where the symbol starts, so that is what the anchor names, with the match line kept beside it.
test("the answer anchors at the enclosing symbol's declaration, naming the match line separately", () => {
    const group: RankedGroup = {
        path: "alpha/src/scheduler.ts",
        score: 1,
        hits: [
            {
                path: "alpha/src/scheduler.ts",
                line: 543,
                text: "                continue;",
                tags: [{ kind: "rerank" as const, score: 0.79 }],
                score: 1,
                context: "createScheduler (fn)",
                contextLine: 119,
            },
        ],
    };
    const rendered = renderText({
        verb: "q",
        echo: '"scheduler wake"',
        unit: "hits",
        style: "hits",
        showTags: true,
        groups: [group],
        offset: 0,
        freshness: { state: "fresh", ageMs: 120 },
        budget: 1500,
        cursorId: "abcd1234",
        lead: true,
        confidence: "confident",
    });
    expect(rendered.text).toContain("answer: alpha/src/scheduler.ts:119 · createScheduler (fn) · match :543 · confident");
});

test("without an enclosing symbol the answer still anchors at the hit, and says nothing about a match line", () => {
    const group: RankedGroup = {
        path: "alpha/src/constants.ts",
        score: 1,
        hits: [{ path: "alpha/src/constants.ts", line: 7, text: "export const LIMIT = 40;", tags: [], score: 1 }],
    };
    const rendered = renderText({
        verb: "q",
        echo: '"limit"',
        unit: "hits",
        style: "hits",
        showTags: false,
        groups: [group],
        offset: 0,
        freshness: { state: "fresh", ageMs: 120 },
        budget: 1500,
        cursorId: "abcd1234",
        lead: true,
    });
    expect(rendered.text).toContain("answer: alpha/src/constants.ts:7");
    expect(rendered.text).not.toContain("match :");
});

// "weak" rides the same slot as confident/ambiguous, before the scores that earned it, so the first line an agent reads
// already says nothing here likely answers.
test("a weak answer names its state on the answer line, ahead of the scores", () => {
    const group: RankedGroup = {
        path: "alpha/src/constants.ts",
        score: 1,
        hits: [
            { path: "alpha/src/constants.ts", line: 7, text: "export const LIMIT = 40;", tags: [{ kind: "rerank" as const, score: 0.03 }], score: 1 },
        ],
    };
    const rendered = renderText({
        verb: "q",
        echo: '"order refunds"',
        unit: "hits",
        style: "hits",
        showTags: true,
        groups: [group],
        offset: 0,
        freshness: { state: "fresh", ageMs: 120 },
        budget: 1500,
        cursorId: "abcd1234",
        lead: true,
        confidence: "weak",
    });
    expect(rendered.text.split("\n")[1]).toBe("answer: alpha/src/constants.ts:7 · weak · [rerank 0.03]");
});

// Facts qualify the answer (a UI string's catalog key, an address's route, the answer's neighbours): printed right
// under it, and admitted against the same capsule share as every optional line, so --budget still holds.
describe("facts under the answer", () => {
    const facts = [
        "key: agents.agentActions.noConversationLeft · web/src/app/i18n/locales/en.json:8 (+4 locales) · used at web/src/features/agents/agentActions.ts:178",
        "siblings: agentStatus.ts · useAgents-actions.ts · Agents.vue · useAgentHistory.ts · +14 more",
    ];
    const withFacts = (budget: number, lead = true): ReturnType<typeof renderText> =>
        renderText({
            verb: "q",
            echo: '"That agent has no conversation left to send to."',
            unit: "hits",
            style: "hits",
            showTags: true,
            groups: groups(40, 6),
            offset: 0,
            freshness: { state: "fresh", ageMs: 120 },
            budget,
            cursorId: "abcd1234",
            lead,
            confidence: "confident",
            facts,
        });

    test("follow the answer line in order, ahead of the candidates", () => {
        const lines = withFacts(1500).text.split("\n");
        expect(lines[1]).toMatch(/^answer: /);
        expect(lines[2]).toBe(facts[0]);
        expect(lines[3]).toBe(facts[1]);
        expect(lines[4]).toMatch(/^candidates: /);
    });

    test("fit inside --budget, dropped whole when they do not", () => {
        for (const budget of [60, 120, 200, 400, 1500]) {
            expect(estimateTokens(withFacts(budget).text), `budget=${budget}`).toBeLessThanOrEqual(budget);
        }
        expect(withFacts(60).text).not.toContain("key: ");
    });

    test("need an answer line to qualify", () => {
        expect(withFacts(1500, false).text).not.toContain("siblings: ");
    });
});
