import type { ReviewFinding, ReviewFindings } from "@intentic/sandbox-contract/events/review";
import type { StatusVariant } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";
import { toWorkspacePath } from "../../../../lib/files/fileRefs";

// What the review card says of a review and each finding, apart from drawing it: the chips, the place, and the words a
// press on Fix puts in the composer. Pure, so the card's wording is tested without mounting it.

export interface FindingChip {
    readonly label: string;
    readonly tone: StatusVariant;
}

const OUTCOME_KEYS = { fixed: `fixed`, skipped: `skipped`, no_change_needed: `noChangeNeeded` } as const;

// Once fixes ran, what happened to it is all that is left to say; until then, how urgent the reviewer rated it and
// whether a pass confirmed it.
export const findingChips = (finding: ReviewFinding): FindingChip[] =>
    finding.outcome === undefined
        ? openChips(finding)
        : [{ label: t(`chat.chatReview.${OUTCOME_KEYS[finding.outcome]}`), tone: finding.outcome === `fixed` ? `success` : `neutral` }];

const openChips = (finding: ReviewFinding): FindingChip[] => [
    ...(finding.priority === undefined
        ? []
        : [{ label: `P${finding.priority}`, tone: finding.priority <= 1 ? (`danger` as const) : finding.priority === 2 ? (`warning` as const) : (`neutral` as const) }]),
    ...(finding.verdict === undefined
        ? []
        : [
              finding.verdict === `CONFIRMED`
                  ? { label: t(`chat.chatReview.confirmed`), tone: `warning` as const }
                  : { label: t(`chat.chatReview.plausible`), tone: `neutral` as const },
          ]),
];

// A reviewer's sentence with its backticked names as code, the way the chat's prose draws them; drawn as text, never as
// markup, since the words are the model's.
export interface SummaryPart {
    readonly text: string;
    readonly code: boolean;
}

export const summaryParts = (summary: string): SummaryPart[] => {
    const pieces = summary.split(`\``);
    // An odd count of backticks leaves the last one unmatched: it stays a backtick rather than swallowing the rest.
    const closed = pieces.length % 2 === 1 ? pieces : [...pieces.slice(0, -2), `${pieces.at(-2) ?? ``}\`${pieces.at(-1) ?? ``}`];
    return closed.map((text, index) => ({ text, code: index % 2 === 1 })).filter((part) => part.text !== ``);
};

// Where it is: the file's name and line for the row, the whole path for its hover and for the agent.
export interface FindingPlace {
    readonly short: string;
    readonly full: string;
}

export const findingPlace = (finding: ReviewFinding): FindingPlace => {
    const name = finding.file.slice(finding.file.lastIndexOf(`/`) + 1);
    const lines = finding.line === undefined ? `` : finding.endLine === undefined ? `:${finding.line}` : `:${finding.line}-${finding.endLine}`;
    return { short: `${name}${lines}`, full: `${finding.file}${lines}` };
};

// The findings still to act on: none once a re-report gave each an outcome.
export const openFindings = (review: ReviewFindings): readonly ReviewFinding[] => review.findings.filter((finding) => finding.outcome === undefined);

const named = (finding: ReviewFinding): string => `${findingPlace(finding).full} — ${finding.summary}`;

// Named as the review named them, so the agent that reported them knows exactly which it is asked to fix.
export const fixRequest = (findings: readonly ReviewFinding[]): string =>
    findings.length === 1
        ? t(`chat.chatReview.fixOneRequest`, { finding: named(findings[0]!) })
        : t(`chat.chatReview.fixAllRequest`, { list: findings.map((finding, index) => `${index + 1}. ${named(finding)}`).join(`\n`) });

// The same findings for the conversation whose work a fresh session reviewed (freshSession.ts), which never saw the
// review: each with its scenario, its place as the workspace names it (a worktree's absolute path is the reviewer's own
// copy), and the ask to judge each against what the work is for rather than fix whatever was flagged.
const described = (finding: ReviewFinding): string => {
    const place = toWorkspacePath(findingPlace(finding).full) ?? findingPlace(finding).full;
    const scenario = finding.scenario ?? finding.body;
    return scenario === undefined ? `${place} — ${finding.summary}` : `${place} — ${finding.summary}\n   ${scenario.replaceAll(`\n`, `\n   `)}`;
};

export const originFixRequest = (findings: readonly ReviewFinding[]): string =>
    findings.length === 1
        ? t(`agents.freshSession.originFixOneRequest`, { finding: described(findings[0]!) })
        : t(`agents.freshSession.originFixAllRequest`, { list: findings.map((finding, index) => `${index + 1}. ${described(finding)}`).join(`\n`) });

// What the card's head says of what was found: how many, or that nothing was.
export const findingsLabel = (review: ReviewFindings): string =>
    review.findings.length === 0 ? t(`chat.chatReview.clean`) : t(`chat.chatReview.findings`, { count: review.findings.length }, review.findings.length);

export const reviewerLabel = (review: ReviewFindings): string =>
    review.source === `claude` ? t(`chat.chatReview.sourceClaude`) : t(`chat.chatReview.sourceCodex`);
