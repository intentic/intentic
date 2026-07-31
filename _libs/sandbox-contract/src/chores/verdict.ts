import type { ChoreLedgerEntry, ChoresReport, ProbeId, ProbeResult } from "../schemas.js";
import { type Chore, type ChoreContext, type ChoreFinding, CHORES, chorePrompt } from "./chores.js";
import { probeSpec } from "./probes.js";

/* FROM EVIDENCE TO A VERDICT — the one place that decides whether a chore is due, and the only place that is
 * allowed to. Both the Maintenance panel and its rail badge run this function over the same report, so the number
 * on the tile and the reason in the panel are the same computation and cannot drift apart.
 *
 * Four states, and the distinctions between them are the whole design:
 *
 *   unavailable  we have not measured this. knip is not a devDependency; there is no lockfile to audit. Rendered
 *                greyed, never badged, and never collapsed into `clear` — a maintenance surface reporting a green
 *                repository it has never actually measured is worse than one that says nothing.
 *   clear        we measured, and there is nothing to do. This is the common state, and it has to be visibly
 *                reachable or the panel is just a list of complaints.
 *   snoozed      the owner said "not now". Still listed, still showing its evidence, silent until it lapses.
 *   due          there is something to do.
 *
 * And one flag that is not a state: `settled`. A due chore whose evidence is UNCHANGED since a turn was already
 * spent on it stays due — because it is — but must never light the rail again. This is what stops the surface
 * repeating itself while a fix sits in review, and it is why the ledger stores a digest rather than a timestamp:
 * "ran 3 days ago" cannot tell you whether it ran against THIS.
 *
 * Nothing here can make a chore invisible. Snoozing, settling and opting out all change whether the rail SPEAKS;
 * the panel shows every chore in every repo, always, with the evidence that decided it. A maintenance surface you
 * can hide problems in is a maintenance surface nobody trusts. */

export type ChoreState = "due" | "clear" | "snoozed" | "unavailable";

export interface ChoreVerdict {
    readonly chore: Chore;
    readonly repo: string;
    readonly state: ChoreState;
    readonly severity: ChoreFinding["severity"];
    // Always present, in every state — "nothing to do" and "not measured" are answers a reader deserves in words.
    readonly headline: string;
    readonly detail: readonly string[];
    // The evidence identity. Empty for `unavailable`, where there is no evidence to identify.
    readonly digest: string;
    // The turn. Present only when there is something to do — a "start an agent" button on a clear chore is an
    // invitation to spend money proving that nothing is wrong.
    readonly prompt: string | undefined;
    readonly lastRun: ChoreLedgerEntry | undefined;
    // A turn has already been spent on exactly this evidence, and the chore's cadence has not lapsed since. Still
    // due, still shown, never badged.
    readonly settled: boolean;
}

// A survey that is clear is clear because it was READ recently, and saying so is the only way its row means
// anything — "nothing to do" under a chore that has no measurement would be a claim about the code rather than
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
        return [`${spec.title} · ${probe.state === `unavailable` ? `not available in this repository` : `failed`}${probe.reason === undefined ? `` : ` — ${probe.reason}`}`];
    });

export const assessChore = (chore: Chore, context: ChoreContext, ledger: ChoreLedgerEntry | undefined): ChoreVerdict => {
    const base = { chore, repo: context.repo, lastRun: ledger, settled: false, prompt: undefined } as const;

    const unmeasured = unmeasuredDetail(chore.needs, context.probes);
    if (unmeasured.length > 0) {
        return { ...base, state: `unavailable`, severity: `info`, headline: `Not measured`, detail: unmeasured, digest: `` };
    }

    const finding = chore.assess(context);
    if (finding === undefined) {
        return { ...base, state: `clear`, severity: `info`, headline: clearHeadline(chore, ledger, context.nowMs), detail: [], digest: `` };
    }

    /* Has the last run's settlement lapsed? A cadence of 0 means "this is decided by evidence alone" — an advisory
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
        return { ...base, state: `clear`, severity: `info`, headline: clearHeadline(chore, ledger, context.nowMs), detail: finding.detail, digest: finding.digest };
    }

    const prompt = chorePrompt(chore, finding, context.repo);

    if (ledger?.snoozedUntil !== undefined && ledger.snoozedUntil > context.nowMs) {
        return { ...base, state: `snoozed`, severity: `info`, headline: finding.headline, detail: finding.detail, digest: finding.digest, prompt };
    }

    /* The agent looked at exactly this evidence and reported that there was nothing in it — knip's findings were
     * all public entry points, the clones were all generated files. That verdict has to stick, or the next poll
     * starts the same turn again and the surface has taught the owner that its rows are wrong. It stops sticking
     * when the evidence changes (a different digest) or the cadence lapses. */
    if (sameEvidence && ledger?.outcome === `clean`) {
        return {
            ...base,
            state: `clear`,
            severity: `info`,
            headline: `Checked — the findings did not hold up`,
            detail: finding.detail,
            digest: finding.digest,
        };
    }

    return { ...base, state: `due`, severity: finding.severity, headline: finding.headline, detail: finding.detail, digest: finding.digest, prompt, settled: sameEvidence };
};

// The ledger is keyed by repo + chore, which is the grain a verdict is decided at: the same chore in two repos is
// two independent questions with two independent answers.
export const ledgerKey = (repo: string, chore: string): string => `${repo}|${chore}`;

/* Every chore in every repo, from one report. This is what both surfaces call — the panel groups the result, the
 * badge filters it — so there is exactly one traversal of the book in the codebase and adding a chore to CHORES
 * reaches both surfaces without touching either. */
export const assessReport = (report: ChoresReport, nowMs: number): ChoreVerdict[] => {
    const ledger = new Map(report.ledger.map((entry) => [ledgerKey(entry.repo, entry.chore), entry]));
    return report.repos.flatMap(({ repo, probes, signals }) => {
        const context: ChoreContext = { repo, probes: new Map(probes.map((probe) => [probe.id, probe])), signals, node: report.node, nowMs };
        return CHORES.map((chore) => assessChore(chore, context, ledger.get(ledgerKey(repo, chore.id))));
    });
};

/* WHAT THE RAIL IS ALLOWED TO SAY. A badge must mean "something happened here that you don't already know about",
 * never "here is a statistic" — the extension API states that bar and this is the function that holds this
 * surface to it. Three filters, and every one of them removes a case that would otherwise light the tile forever:
 *
 *   state === due   the obvious one.
 *   !settled        a turn has already been spent on this exact evidence.
 *   unseen digest   the owner has already LOOKED at this evidence in the panel. Acknowledgement is per digest
 *                   rather than per chore, so acknowledging today's finding does not also swallow tomorrow's.
 *
 * `seen` maps ledgerKey → the digest last acknowledged. It lives in a file beside the ledger, because the badge is
 * derived from files and its acknowledgement belongs in the same tree. */
export const unseenVerdicts = (verdicts: readonly ChoreVerdict[], seen: Readonly<Record<string, string>>): ChoreVerdict[] =>
    verdicts.filter((verdict) => verdict.state === `due` && !verdict.settled && seen[ledgerKey(verdict.repo, verdict.chore.id)] !== verdict.digest);
