import type { IssueSummary } from "@intentic/sandbox-contract";
import { TITLE_MAX } from "../automations/scheduler.js";

// Everything a stranger's machine wrote sits under `untrusted`; everything the daemon knows for itself sits outside it,
// so a hostile description reads as a quote, not a heading. The trigger catalogue's prompt is written against these
// exact key names, so renaming one here without renaming it there silently breaks the framing. Counts and timestamps
// stay top-level: the one part of the payload nobody outside can influence except by actually crashing.

// An epoch stamp as something a model reads without arithmetic. The sandbox clock is UTC.
const when = (at: number): string => new Date(at).toISOString();

// Payload cap for stack+breadcrumbs, well under scheduler's PAYLOAD_MAX so it fails on size, not the bug.
const PAYLOAD_BUDGET = 48_000;
const STACK_FLOOR = 8_000;

export interface WakeBrief {
    readonly payload: string;
    readonly title: string;
}

// The brief for one issue's wake; `why` distinguishes the three doors it can arrive through, since the right first move
// differs (reproduce new, re-examine a recurrence, or just do what the owner clicked on).
export const wakeBrief = (issue: IssueSummary, why: "new" | "recurring" | "asked"): WakeBrief => {
    const brief = {
        issue: issue.id,
        kind: issue.kind,
        why,
        title: issue.title,
        ...factsOf(issue),
        untrusted: untrustedOf(issue.sample),
    };
    return { payload: trimmed(brief), title: titleFor(issue, why) };
};

// What the daemon knows for itself (severity, since when, from where, against which build); the one part nobody outside
// can influence except by crashing.
const factsOf = (issue: IssueSummary): Record<string, unknown> => ({
    ...(issue.culprit !== undefined ? { culprit: issue.culprit } : {}),
    count: issue.count,
    firstSeen: when(issue.firstSeen),
    lastSeen: when(issue.lastSeen),
    ...(issue.origin !== undefined ? { site: issue.origin } : {}),
    // Replaces a sourcemap pipeline; named plainly at the top level so the agent doesn't miss which build broke.
    ...(issue.release !== undefined ? { release: issue.release } : {}),
    ...(issue.runs !== undefined && issue.runs.length > 0
        ? { previousRuns: issue.runs.map((run) => ({ conversationId: run.conversationId, at: when(run.at), atCount: run.atCount })) }
        : {}),
});

// Everything somebody else's machine produced, under one key that says so.
const untrustedOf = (report: IssueSummary["sample"]): Record<string, unknown> => ({
    message: report.message,
    ...(report.url !== undefined ? { page: report.url } : {}),
    ...(report.stack !== undefined ? { stack: report.stack } : {}),
    ...(report.description !== undefined ? { whatThePersonWrote: report.description } : {}),
    // Self-declared, every field of it, and named so that no reading of it turns into identity.
    ...(report.reporter !== undefined ? { unverifiedReporter: report.reporter } : {}),
    ...(report.userAgent !== undefined ? { userAgent: report.userAgent } : {}),
    ...(report.context !== undefined ? { appContext: report.context } : {}),
    ...(report.breadcrumbs !== undefined ? { breadcrumbs: report.breadcrumbs } : {}),
});

// Sheds weight in the order costing least understanding: breadcrumbs first, then the tail of the stack (frames furthest
// from the break). Bounded on the serialized string, since that's what the prompt and guard's env actually carry.
const trimmed = (brief: { untrusted: { stack?: string; breadcrumbs?: unknown[] } }): string => {
    const full = JSON.stringify(brief);
    if (full.length <= PAYLOAD_BUDGET) {
        return full;
    }
    const withoutCrumbs = { ...brief, untrusted: { ...brief.untrusted, breadcrumbs: undefined } };
    const shorter = JSON.stringify(withoutCrumbs);
    if (shorter.length <= PAYLOAD_BUDGET || brief.untrusted.stack === undefined) {
        return shorter;
    }
    const room = Math.max(STACK_FLOOR, brief.untrusted.stack.length - (shorter.length - PAYLOAD_BUDGET));
    return JSON.stringify({
        ...withoutCrumbs,
        untrusted: { ...withoutCrumbs.untrusted, stack: `${brief.untrusted.stack.slice(0, room)}\n… truncated` },
    });
};

// The card's title, the only thing telling two wakes of one automation apart on the board (the prompt is always
// identical). The count rides along for a recurrence, since "×214" vs "×2" is judged straight off the board.
const titleFor = (issue: IssueSummary, why: "new" | "recurring" | "asked"): string => {
    const lead = issue.kind === "report" ? "Reported" : why === "recurring" ? `Crash ×${issue.count}` : "Crash";
    return `${lead}: ${issue.title}`.slice(0, TITLE_MAX);
};
