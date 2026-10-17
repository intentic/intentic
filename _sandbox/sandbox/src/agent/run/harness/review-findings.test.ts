import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import { REVIEW_TEXT_MAX } from "@intentic/sandbox-contract/events/review";
import { ReportFindingsInputSchema, reviewHooks, reviewOfReport } from "./review-findings.js";

// The ReportFindings input as Claude Code 2.1.302's tool schema spells it.
const REPORT = {
    level: "high",
    findings: [
        {
            file: "src/parse.ts",
            line: 12,
            summary: "Off-by-one drops the last token.",
            short_summary: "Last token dropped",
            failure_scenario: "parse('a b') returns ['a'].",
            category: "correctness",
            verdict: "CONFIRMED",
        },
        { file: "src/cache.ts", summary: "The cache never expires.", verdict: "plausible" },
    ],
};

test("a report becomes the review the card draws, in the card's own words", () => {
    const review = reviewOfReport(ReportFindingsInputSchema.parse(REPORT));
    expect(review).toMatchObject({ source: "claude", level: "high" });
    expect(review.findings).toEqual([
        {
            file: "src/parse.ts",
            line: 12,
            summary: "Off-by-one drops the last token.",
            title: "Last token dropped",
            scenario: "parse('a b') returns ['a'].",
            category: "correctness",
            verdict: "CONFIRMED",
        },
        { file: "src/cache.ts", summary: "The cache never expires.", verdict: "PLAUSIBLE" },
    ]);
});

// The skill re-reports its findings with outcomes once it has fixed them: the same card, redrawn.
test("a re-report of the same findings with their outcomes keeps the review's id", () => {
    const first = reviewOfReport(ReportFindingsInputSchema.parse(REPORT));
    const fixed = reviewOfReport(ReportFindingsInputSchema.parse({ ...REPORT, findings: REPORT.findings.map((finding) => ({ ...finding, outcome: "fixed" })) }));
    expect(fixed.id).toBe(first.id);
    expect(fixed.findings.every((finding) => finding.outcome === "fixed")).toBe(true);
    const other = reviewOfReport(ReportFindingsInputSchema.parse({ findings: [{ file: "src/a.ts", summary: "Another." }] }));
    expect(other.id).not.toBe(first.id);
});

test("spellings the card has no chip for, a line that is no line, and runaway prose are left off or cut", () => {
    const review = reviewOfReport(
        ReportFindingsInputSchema.parse({ level: "ultra", findings: [{ file: "a.ts", line: 0, summary: "x".repeat(REVIEW_TEXT_MAX + 50), verdict: "maybe" }] }),
    );
    expect(review.level).toBeUndefined();
    expect(review.findings[0]?.line).toBeUndefined();
    expect(review.findings[0]?.verdict).toBeUndefined();
    expect(review.findings[0]?.summary).toHaveLength(REVIEW_TEXT_MAX);
});

const callHook = async (hooks: ReturnType<typeof reviewHooks>, toolInput: unknown): Promise<void> => {
    const input = { hook_event_name: "PostToolUse" as const, tool_name: "ReportFindings", tool_input: toolInput, tool_response: {}, tool_use_id: "t1" };
    await hooks.PostToolUse[0]?.hooks[0]?.({ ...input, session_id: "s", transcript_path: "", cwd: "" });
};

test("the hook pushes the review once the call is made, and nothing for an input it cannot read", async () => {
    const pushed: AgentEvent[] = [];
    const hooks = reviewHooks((event) => pushed.push(event));
    expect(hooks.PostToolUse[0]?.matcher).toBe("^ReportFindings$");
    await callHook(hooks, REPORT);
    await callHook(hooks, { findings: "none" });
    expect(pushed).toHaveLength(1);
    expect(pushed[0]).toMatchObject({ kind: "review", review: { source: "claude", level: "high" } });
});
