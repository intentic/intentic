import type { ChoreLedgerEntry, ChoreOutcome, ChoresReport, ProbeId, ProbeResult } from "../schemas/maintenance.js";
import { type Chore, type ChoreContext, type ChoreFinding, CHORES, chorePrompt } from "./chores.js";
import { probeSpec } from "./probes.js";

// The one function deciding whether a chore is due, run by both the panel and its badge over the same report so
// neither can drift from the other. Six states (not-applicable, unavailable and clear are different ways of saying no);
// `settled` is a due chore re-measured with no change, still due but never re-badged.

export type ChoreState = "due" | "clear" | "snoozed" | "stale" | "unavailable" | "not-applicable";

export interface ChoreVerdict {
    readonly chore: Chore;
    readonly repo: string;
    readonly state: ChoreState;
    readonly severity: ChoreFinding["severity"];
    // Always present in every state; "nothing to do" and "not measured" are answers a reader deserves in words.
    readonly headline: string;
    readonly detail: readonly string[];
    // The evidence identity. Empty for `unavailable`, where there is no evidence to identify.
    readonly digest: string;
    // When the evidence was taken; undefined when the verdict rests on no measurement (a survey, or unavailable).
    readonly measuredAt: number | undefined;
    // Present only when there is something to do; offering it on a clear chore would invite proving nothing's wrong.
    readonly prompt: string | undefined;
    readonly lastRun: ChoreLedgerEntry | undefined;
    // A turn was spent, the evidence was re-measured since and didn't move, and the cadence hasn't lapsed: still due,
    // still shown, never badged.
    readonly settled: boolean;
}

// How old the evidence is: the oldest of the measurements a verdict rests on, since a claim is only as current
// as the least current input. Undefined when it rests on none (a survey, or an unavailable probe).
const measurementAge = (needs: readonly ProbeId[], probes: ReadonlyMap<ProbeId, ProbeResult>): number | undefined => {
    const taken = needs.flatMap((id) => {
        const probe = probes.get(id);
        return probe?.state === `ok` ? [probe.ranAt] : [];
    });
    return taken.length === 0 ? undefined : Math.min(...taken);
};

// A clear survey says when it was last read, since "nothing to do" under a chore with no measurement would be a
// claim about the code rather than the calendar.
const clearHeadline = (chore: Chore, lastRun: ChoreLedgerEntry | undefined, nowMs: number): string =>
    chore.survey === true && lastRun !== undefined ? `Surveyed ${Math.round((nowMs - lastRun.ranAt) / 86_400_000)} days ago` : `Nothing to do`;

// Why a chore couldn't be assessed, in the words of the thing that couldn't: never invented, an `unavailable`
// probe carries the tool's own reason, an unrun one says it hasn't run yet.
const unmeasuredDetail = (needs: readonly ProbeId[], probes: ReadonlyMap<ProbeId, ProbeResult>): string[] =>
    needs.flatMap((id) => {
        const probe = probes.get(id);
        const spec = probeSpec(id);
        if (probe === undefined) {
            return [`${spec.title} · not measured yet`];
        }
        if (probe.state === `ok`) {
            return [];
        }
        // An unavailable probe's reason already says what's missing; prefixing it would just say the same thing twice.
        if (probe.state === `unavailable`) {
            return [`${spec.title} · ${probe.reason ?? `not available in this repository`}`];
        }
        return [`${spec.title} · failed${probe.reason === undefined ? `` : `, ${probe.reason}`}`];
    });

export const assessChore = (chore: Chore, context: ChoreContext, ledger: ChoreLedgerEntry | undefined): ChoreVerdict => {
    const base = { chore, repo: context.repo, lastRun: ledger, settled: false, prompt: undefined } as const;

    // Decided before anything is measured; the cause is carried as the headline since the scope note is the only place
    // it is read.
    const inapplicable = chore.applies?.(context.signals);
    if (inapplicable !== undefined) {
        return { ...base, state: `not-applicable`, severity: `info`, headline: inapplicable, detail: [], digest: ``, measuredAt: undefined };
    }

    const unmeasured = unmeasuredDetail(chore.needs, context.probes);
    if (unmeasured.length > 0) {
        return { ...base, state: `unavailable`, severity: `info`, headline: `Not measured`, detail: unmeasured, digest: ``, measuredAt: undefined };
    }

    // Every state below this line rests on a measurement that ran, so all of them carry when it was taken.
    const measuredAt = measurementAge(chore.needs, context.probes);

    const finding = chore.assess(context);
    if (finding === undefined) {
        return {
            ...base,
            state: `clear`,
            severity: `info`,
            headline: clearHeadline(chore, ledger, context.nowMs),
            detail: [],
            digest: ``,
            measuredAt,
        };
    }

    // A cadence of 0 is decided by evidence alone; any other cadence expires its own settlement over time.
    const lapsed = ledger !== undefined && chore.cadenceMs > 0 && context.nowMs - ledger.ranAt >= chore.cadenceMs;
    const sameEvidence = ledger?.digest === finding.digest && !lapsed;

    // A survey's only trigger is the calendar, checked against the run's time rather than its digest.
    if (chore.survey === true && ledger !== undefined && context.nowMs - ledger.ranAt < chore.cadenceMs) {
        return {
            ...base,
            state: `clear`,
            severity: `info`,
            headline: clearHeadline(chore, ledger, context.nowMs),
            detail: finding.detail,
            digest: finding.digest,
            measuredAt,
        };
    }

    const prompt = chorePrompt(chore, finding, context.repo);

    if (ledger?.snoozedUntil !== undefined && ledger.snoozedUntil > context.nowMs) {
        return {
            ...base,
            state: `snoozed`,
            severity: `info`,
            headline: finding.headline,
            detail: finding.detail,
            digest: finding.digest,
            measuredAt,
            prompt,
        };
    }

    // The agent looked at exactly this evidence and found nothing there; that verdict sticks until the evidence changes
    // or the cadence lapses.
    if (sameEvidence && ledger?.outcome === `clean`) {
        return {
            ...base,
            state: `clear`,
            severity: `info`,
            headline: `Checked, the findings did not hold up`,
            detail: finding.detail,
            digest: finding.digest,
            measuredAt,
        };
    }

    // The measurement predates the last run: an unchanged digest is what a stale probe produces too, so the claim and
    // prompt come off, not the evidence.
    if (ledger !== undefined && measuredAt !== undefined && ledger.ranAt > measuredAt) {
        return { ...base, state: `stale`, severity: `info`, headline: finding.headline, detail: finding.detail, digest: finding.digest, measuredAt };
    }

    return {
        ...base,
        state: `due`,
        severity: finding.severity,
        headline: finding.headline,
        detail: finding.detail,
        digest: finding.digest,
        measuredAt,
        prompt,
        settled: sameEvidence,
    };
};

// Has anyone already answered this, and does the answer still stand; the digest is what makes this an answer
// rather than a timestamp, since a run against evidence that has since changed answered a different question.
export interface ChoreAnswer {
    readonly outcome: ChoreOutcome;
    readonly ranAt: number;
}

// What was concluded about this evidence, whenever that was: history, not standing. A lapsed chore still shows
// its old answer, since that is a fact worth having before spending a second turn.
export const choreAnswer = (verdict: ChoreVerdict): ChoreAnswer | undefined => {
    const { lastRun, digest } = verdict;
    // An empty digest identifies no evidence, so nothing can have been concluded about it (unavailable, not-applicable,
    // plain clear).
    if (lastRun === undefined || digest === `` || lastRun.digest !== digest) {
        return undefined;
    }
    return { outcome: lastRun.outcome, ranAt: lastRun.ranAt };
};

// Whether there is anything left to start: `settled` or `stale`, not gated on `choreAnswer`, since a stale row
// has nothing to press either way. A lapsed chore returns to full weight; expiry asks again.
export const choreAnswered = (verdict: ChoreVerdict): boolean => verdict.settled || verdict.state === `stale`;

// The ledger is keyed by repo + chore, the grain a verdict is decided at: the same chore in two repos is two
// independent answers.
export const ledgerKey = (repo: string, chore: string): string => `${repo}|${chore}`;

// Every chore in every repo, from one report; the single traversal both the panel and the badge call, so adding
// a chore to CHORES reaches both without touching either.
export const assessReport = (report: ChoresReport, nowMs: number): ChoreVerdict[] => {
    const ledger = new Map(report.ledger.map((entry) => [ledgerKey(entry.repo, entry.chore), entry]));
    return report.repos.flatMap(({ repo, probes, signals }) => {
        const context: ChoreContext = { repo, probes: new Map(probes.map((probe) => [probe.id, probe])), signals, node: report.node, nowMs };
        return CHORES.map((chore) => assessChore(chore, context, ledger.get(ledgerKey(repo, chore.id))));
    });
};

// What the rail may say: something happened you don't already know about, never a statistic. Filters out:
// - not due, or settled (a turn already re-measured this with no change)
// - already acknowledged at this exact digest in the panel
export const unseenVerdicts = (verdicts: readonly ChoreVerdict[], seen: Readonly<Record<string, string>>): ChoreVerdict[] =>
    verdicts.filter((verdict) => verdict.state === `due` && !verdict.settled && seen[ledgerKey(verdict.repo, verdict.chore.id)] !== verdict.digest);
