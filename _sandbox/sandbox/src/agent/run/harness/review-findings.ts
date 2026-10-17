import { createHash } from "node:crypto";
import type { HookCallbackMatcher, HookEvent } from "@anthropic-ai/claude-agent-sdk";
import { z } from "zod";
import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import {
    REVIEW_FINDINGS_MAX,
    REVIEW_LEVELS,
    REVIEW_TEXT_MAX,
    type ReviewFinding,
    type ReviewFindings,
    type ReviewLevel,
} from "@intentic/sandbox-contract/events/review";
import { opt } from "../../../opt.js";

// Claude Code's `/code-review`, with REPORT_FINDINGS pinned on (pinned-env.ts), ends in a ReportFindings call whose
// input is the review's findings, typed, and prints none of them as prose. Read whole by a PostToolUse hook, since the
// tool card keeps only a few kilobytes of a call's input, and pushed as the review the chat draws as one card.

const REPORT_FINDINGS_TOOL = "ReportFindings";

// Read loosely: a CLI that renames an enum's spelling should cost a chip on the card, never the card.
export const ReportFindingsInputSchema = z.object({
    level: z.string().optional(),
    findings: z.array(
        z.object({
            file: z.string(),
            line: z.number().optional(),
            summary: z.string(),
            short_summary: z.string().optional(),
            failure_scenario: z.string().optional(),
            category: z.string().optional(),
            verdict: z.string().optional(),
            outcome: z.string().optional(),
        }),
    ),
});
export type ReportFindingsInput = z.infer<typeof ReportFindingsInputSchema>;
type Reported = ReportFindingsInput["findings"][number];

const cut = (text: string | undefined): string | undefined =>
    text === undefined || text.length <= REVIEW_TEXT_MAX ? text : `${text.slice(0, REVIEW_TEXT_MAX - 1)}…`;

const oneOf = <T extends string>(choices: readonly T[], value: string | undefined): T | undefined =>
    choices.find((choice) => choice.toLowerCase() === value?.toLowerCase());

const findingOf = (reported: Reported): ReviewFinding => ({
    file: reported.file,
    ...opt("line", reported.line !== undefined && Number.isInteger(reported.line) && reported.line > 0 ? reported.line : undefined),
    summary: cut(reported.summary) ?? "",
    ...opt("title", cut(reported.short_summary)),
    ...opt("scenario", cut(reported.failure_scenario)),
    ...opt("category", reported.category),
    ...opt("verdict", oneOf(["CONFIRMED", "PLAUSIBLE"] as const, reported.verdict)),
    ...opt("outcome", oneOf(["fixed", "skipped", "no_change_needed"] as const, reported.outcome)),
});

// Named by what it found rather than by the call: the skill re-reports the same findings with their outcomes once it
// has fixed them, often a turn later, and that report is a redraw of this card, not a second one.
const reviewIdOf = (findings: readonly ReviewFinding[]): string =>
    `review-${createHash("sha256")
        .update(findings.map((finding) => `${finding.file}\n${finding.summary}`).join("\n\n"))
        .digest("hex")
        .slice(0, 16)}`;

// The review a ReportFindings call reports.
export const reviewOfReport = (report: ReportFindingsInput): ReviewFindings => {
    const findings = report.findings.slice(0, REVIEW_FINDINGS_MAX).map(findingOf);
    const level: ReviewLevel | undefined = oneOf(REVIEW_LEVELS, report.level);
    return { id: reviewIdOf(findings), source: "claude", ...opt("level", level), findings };
};

// After the call, never holding it: a report this reader cannot make out leaves the tool card standing alone.
export const reviewHooks = (push: (event: AgentEvent) => void) =>
    ({
        PostToolUse: [
            {
                matcher: `^${REPORT_FINDINGS_TOOL}$`,
                hooks: [
                    async (input) => {
                        const report = input.hook_event_name === "PostToolUse" ? ReportFindingsInputSchema.safeParse(input.tool_input) : undefined;
                        if (report?.success === true) {
                            push({ kind: "review", review: reviewOfReport(report.data) });
                        }
                        return {};
                    },
                ],
            },
        ],
    }) satisfies Partial<Record<HookEvent, HookCallbackMatcher[]>>;
