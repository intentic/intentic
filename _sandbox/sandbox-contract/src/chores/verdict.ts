import type { ChoreLedgerEntry, ChoresReport, ProbeId, ProbeResult } from "../schemas/maintenance.js";
import { type Chore, type ChoreContext, type ChoreFinding, CHORES, chorePrompt } from "./chores.js";
import { probeSpec } from "./probes.js";

/* FROM EVIDENCE TO A VERDICT, the one place that decides whether a chore is due, and the only place that is
 * allowed to. Both the Maintenance panel and its rail badge run this function over the same report, so the number
 * on the tile and the reason in the panel are the same computation and cannot drift apart.
 *
 * Six states, and the distinctions between them are the whole design:
 *
 *   not-applicable  this chore is not a QUESTION worth asking of this repository, there is no Dockerfile to
 *                slim, no pipeline to tighten, no documentation to re-read. Dropped from the panel entirely
 *                rather than shown as clear, because "clear" claims we checked, and there was nothing to check.
 *                The reason survives in the scope strip, so "why is there no Docker chore here?" has an answer.
 *   unavailable  we have not measured this. knip is not a devDependency; there is no lockfile to audit. Rendered
 *                greyed, never badged, and never collapsed into `clear`, a maintenance surface reporting a green
 *                repository it has never actually measured is worse than one that says nothing.
 *   clear        we measured, and there is nothing to do. This is the common state, and it has to be visibly
 *                reachable or the panel is just a list of complaints.
 *   snoozed      the owner said "not now". Still listed, still showing its evidence, silent until it lapses.
 *   stale        we measured, then work landed, and we have not measured since. The evidence is still shown; the
 *                CLAIM comes off it, because it describes a tree that no longer exists.
 *   due          there is something to do.
 *
 * The first three are all ways of saying "no", and keeping them apart is what makes the surface trustworthy: they
 * mean we cannot ask, we did not measure, and we measured and found nothing, three different claims, and only
 * the last one is reassurance.
 *
 * And one flag that is not a state: `settled`. A due chore that has been RE-MEASURED since a turn was spent on
 * it, and whose evidence did not move, stays due, because it is, but must never light the rail again. This is
 * what stops the surface repeating itself while a fix sits in review, and it is why the ledger stores a digest
 * rather than a timestamp: "ran 3 days ago" cannot tell you whether it ran against THIS.
 *
 * `stale` is the other half of that sentence, and it exists because the digest alone cannot tell the two apart.
 * A probe that never re-ran produces an unchanged digest for free, so "the fix did not move the numbers" and "we
 * have not looked since the fix" arrived at this function looking identical, and the panel showed the second as
 * the first, quoting a week-old count an hour after the work that invalidated it. Comparing the run's time to the
 * MEASUREMENT's time is what separates them, and it is a comparison of two numbers the report already carries.
 *
 * Nothing here can hide a problem. Snoozing and settling change whether the rail SPEAKS; the panel still shows
 * the chore, its evidence and its state. The one thing that removes a row entirely is `not-applicable`, and that
 * is not hiding, it is the absence of a subject, counted in the panel's scope strip and expandable to the reason.
 * A maintenance surface you can quietly bury findings in is a maintenance surface nobody trusts. */

export type ChoreState = "due" | "clear" | "snoozed" | "stale" | "unavailable" | "not-applicable";

export interface ChoreVerdict {
    readonly chore: Chore;
    readonly repo: string;
    readonly state: ChoreState;
    readonly severity: ChoreFinding["severity"];
    // Always present, in every state, "nothing to do" and "not measured" are answers a reader deserves in words.
    readonly headline: string;
    readonly detail: readonly string[];
    // The evidence identity. Empty for `unavailable`, where there is no evidence to identify.
    readonly digest: string;
    /* WHEN THE EVIDENCE WAS TAKEN, the fact every row shows beside its numbers, and the one whose absence let a
     * measurement from last Tuesday read as this morning's. Undefined when the verdict rests on no measurement at
     * all: a survey is decided by the calendar, and an unavailable chore has nothing to be out of date. */
    readonly measuredAt: number | undefined;
    // The turn. Present only when there is something to do, a "start an agent" button on a clear chore is an
    // invitation to spend money proving that nothing is wrong.
    readonly prompt: string | undefined;
    readonly lastRun: ChoreLedgerEntry | undefined;
    // A turn has been spent on this chore, the evidence has been re-measured since and did not move, and the
    // chore's cadence has not lapsed. Still due, still shown, never badged.
    readonly settled: boolean;
}

/* HOW OLD THE EVIDENCE IS: the OLDEST of the measurements a verdict rests on, because a claim is only as current
 * as the least current thing it was computed from. Undefined when it rests on none, a survey has no measurement,
 * and an unavailable chore's probe did not produce one. */
const measurementAge = (needs: readonly ProbeId[], probes: ReadonlyMap<ProbeId, ProbeResult>): number | undefined => {
    const taken = needs.flatMap((id) => {
        const probe = probes.get(id);
        return probe?.state === `ok` ? [probe.ranAt] : [];
    });
    return taken.length === 0 ? undefined : Math.min(...taken);
};

// A survey that is clear is clear because it was READ recently, and saying so is the only way its row means
// anything, "nothing to do" under a chore that has no measurement would be a claim about the code rather than
// about the calendar.
const clearHeadline = (chore: Chore, lastRun: ChoreLedgerEntry | undefined, nowMs: number): string =>
    chore.survey === true && lastRun !== undefined ? `Surveyed ${Math.round((nowMs - lastRun.ranAt) / 86_400_000)} days ago` : `Nothing to do`;

// Why a chore could not be assessed, in the words of the thing that could not do it. Never invented: an
// `unavailable` probe carries the tool's own reason, and a probe that has simply not run yet says that.
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
        // An unavailable probe's reason already says what is missing ("no lockfile"), so prefixing it with "not
        // available in this repository" only says the same thing twice. A failure has to keep its label: its
        // reason is the tool's own output, which on its own reads as a fact rather than as a breakage.
        if (probe.state === `unavailable`) {
            return [`${spec.title} · ${probe.reason ?? `not available in this repository`}`];
        }
        return [`${spec.title} · failed${probe.reason === undefined ? `` : `, ${probe.reason}`}`];
    });

export const assessChore = (chore: Chore, context: ChoreContext, ledger: ChoreLedgerEntry | undefined): ChoreVerdict => {
    const base = { chore, repo: context.repo, lastRun: ledger, settled: false, prompt: undefined } as const;

    /* APPLICABILITY FIRST, before anything is measured or any evidence is read. A chore that does not apply is
     * not "clear" and not "unmeasured", the question does not arise here, and every subsequent branch of this
     * function would be answering it anyway. The cause is carried as the headline, because the scope strip, which
     * groups these rows BY it, is the only place it will ever be read. */
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

    /* Has the last run's settlement lapsed? A cadence of 0 means "this is decided by evidence alone", an advisory
     * does not become worth looking at again because ninety days passed, it becomes worth looking at again when
     * the advisory set changes. Anything with a cadence expires its own settlement, so "we looked and chose not to
     * act" cannot silence a chore for good. */
    const lapsed = ledger !== undefined && chore.cadenceMs > 0 && context.nowMs - ledger.ranAt >= chore.cadenceMs;
    const sameEvidence = ledger?.digest === finding.digest && !lapsed;

    /* A SURVEY has no measurement, so the calendar is the whole trigger: it is due because it has been that long,
     * and a run inside the current period settles it until the next one begins. Checked against the run's TIME
     * rather than its digest, because a survey run three days into a quarter and one three days before its end
     * are the same period but very different answers to "when was this last read?". */
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

    /* The agent looked at exactly this evidence and reported that there was nothing in it, knip's findings were
     * all public entry points, the clones were all generated files. That verdict has to stick, or the next poll
     * starts the same turn again and the surface has taught the owner that its rows are wrong. It stops sticking
     * when the evidence changes (a different digest) or the cadence lapses. */
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

    /* THE MEASUREMENT IS OLDER THAN THE WORK. A turn landed after the last time we looked, so the evidence below
     * describes a tree that no longer exists, an hour after a run deleted the dead code, the row was still
     * quoting the count from six days before it. `sameEvidence` cannot catch this: an unchanged digest is exactly
     * what a probe that never re-ran produces, so the flag says "settled" at its most confident when it knows
     * least. The chore steps down instead, evidence stays on the row, the CLAIM comes off it, and carries no
     * prompt, because the honest next move is to measure again rather than to spend a second turn on a finding
     * nobody has re-checked. It cannot badge either, which is what stops the tile lighting for work already done. */
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

// The ledger is keyed by repo + chore, which is the grain a verdict is decided at: the same chore in two repos is
// two independent questions with two independent answers.
export const ledgerKey = (repo: string, chore: string): string => `${repo}|${chore}`;

/* Every chore in every repo, from one report. This is what both surfaces call, the panel groups the result, the
 * badge filters it, so there is exactly one traversal of the book in the codebase and adding a chore to CHORES
 * reaches both surfaces without touching either. */
export const assessReport = (report: ChoresReport, nowMs: number): ChoreVerdict[] => {
    const ledger = new Map(report.ledger.map((entry) => [ledgerKey(entry.repo, entry.chore), entry]));
    return report.repos.flatMap(({ repo, probes, signals }) => {
        const context: ChoreContext = { repo, probes: new Map(probes.map((probe) => [probe.id, probe])), signals, node: report.node, nowMs };
        return CHORES.map((chore) => assessChore(chore, context, ledger.get(ledgerKey(repo, chore.id))));
    });
};

/* WHAT THE RAIL IS ALLOWED TO SAY. A badge must mean "something happened here that you don't already know about",
 * never "here is a statistic", the extension API states that bar and this is the function that holds this
 * surface to it. Three filters, and every one of them removes a case that would otherwise light the tile forever:
 *
 *   state === due   the obvious one, and it is also what keeps `stale` silent, since a measurement taken before
 *                   the last turn is not a fact anyone should be interrupted about.
 *   !settled        a turn has been spent on this chore and the re-measured evidence did not move.
 *   unseen digest   the owner has already LOOKED at this evidence in the panel. Acknowledgement is per digest
 *                   rather than per chore, so acknowledging today's finding does not also swallow tomorrow's.
 *
 * `seen` maps ledgerKey → the digest last acknowledged. It lives in a file beside the ledger, because the badge is
 * derived from files and its acknowledgement belongs in the same tree. */
export const unseenVerdicts = (verdicts: readonly ChoreVerdict[], seen: Readonly<Record<string, string>>): ChoreVerdict[] =>
    verdicts.filter((verdict) => verdict.state === `due` && !verdict.settled && seen[ledgerKey(verdict.repo, verdict.chore.id)] !== verdict.digest);
