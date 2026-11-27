import { z } from "zod";
import type { Finding, FindingAction, FindingLane, FindingSeverity, FindingSource, Impact } from "../wire.js";
import type { Alert, ErrorIssue, ErrorIssueDetail, Experiment, HealthIssue, HealthIssueDetail, Recommendation, Report } from "./posthog.js";
import { postHogPage } from "./posthog.js";

/* WHAT POSTHOG SAID, AS FINDINGS. Pure: every function here takes what one poll read and answers the rows the view,
   the badge and the agent's tool read, so the rules that decide a row's section and loudness are tested without a
   network. A finding's lane is the decision that matters most: only `fix` and `step` rows count on the badge. */

const DAY_MS = 24 * 60 * 60_000;
// An error first seen this recently is new, which raises it a step.
const NEW_FOR_MS = 7 * DAY_MS;
// How many of the most frequent active errors are always shown, new or not.
const TOP_ERRORS = 5;
// An experiment running this long with no conclusion asks for a decision.
const EXPERIMENT_DECIDE_MS = 14 * DAY_MS;
// The longest stretch of event-supplied text a finding carries: enough to recognise, never a whole payload.
const UNTRUSTED_MAX = 1_200;

export interface SourceContext {
    readonly connection: string;
    readonly host: string;
    readonly projectId: string;
    readonly now: number;
    // Ids of findings marked fixed from here, with when: one active again came back.
    readonly resolved: Readonly<Record<string, number>>;
}

export const findingId = (connection: string, source: FindingSource, sourceId: string): string => `${connection}:${source}:${sourceId}`;

const msOf = (iso: string | undefined): number | undefined => {
    if (iso === undefined) {
        return undefined;
    }
    const ms = Date.parse(iso);
    return Number.isNaN(ms) ? undefined : ms;
};

const clip = (text: string): string => (text.length > UNTRUSTED_MAX ? `${text.slice(0, UNTRUSTED_MAX)}…` : text);

// Keeps only the evidence that is there, each cut to a recognisable length.
const evidence = (fields: Readonly<Record<string, string | undefined>>): Record<string, string> =>
    Object.fromEntries(Object.entries(fields).flatMap(([key, value]) => (value === undefined || value.trim() === `` ? [] : [[key, clip(value)]])));

interface Base {
    readonly source: FindingSource;
    readonly sourceId: string;
    readonly kind: string;
    readonly lane: FindingLane;
    readonly severity: FindingSeverity;
    readonly title: string;
    readonly summary: string;
    readonly path: string;
    readonly actions: readonly FindingAction[];
}

const finding = (ctx: SourceContext, base: Base, extra: Partial<Finding> = {}): Finding => ({
    id: findingId(ctx.connection, base.source, base.sourceId),
    connection: ctx.connection,
    source: base.source,
    sourceId: base.sourceId,
    kind: base.kind,
    lane: base.lane,
    severity: base.severity,
    title: base.title,
    summary: base.summary,
    link: postHogPage(ctx.host, ctx.projectId, base.path),
    code: [],
    untrusted: {},
    actions: [...base.actions],
    ...extra,
});

// ---- health checks ---------------------------------------------------------------------------------------------------

// Health checks whose fix is a PostHog project setting or an account, never a commit: the owner's step. Every other kind
// is offered to an agent, which says `Owner step:` itself when no commit fixes it (fix.ts).
const STEP_KINDS: ReadonlySet<string> = new Set([`authorized_urls`]);
const STEP_KIND_WORDS = /warehouse|billing|quota|integration|permission|subscription/;

export const healthLane = (kind: string, detail: HealthIssueDetail | undefined): FindingLane => {
    if (STEP_KINDS.has(kind) || STEP_KIND_WORDS.test(kind)) {
        return `step`;
    }
    // Guidance for a person and none for an agent: PostHog itself says this is done in its UI.
    const remediation = detail?.remediation;
    return remediation !== undefined && remediation.agent === undefined && remediation.human !== undefined ? `step` : `fix`;
};

const severityOf = (word: string): FindingSeverity => (word === `critical` ? `critical` : word === `warning` ? `warning` : `info`);

// A check's kind as words, for when PostHog's detail could not be read: `sdk_outdated` → "Sdk outdated".
const kindWords = (kind: string): string => {
    const words = kind.replaceAll(`_`, ` `);
    return `${words.charAt(0).toUpperCase()}${words.slice(1)}`;
};

// The sentence most checks put in their payload, when it is one.
const ReasonSchema = z.string();
const reasonOf = (issue: HealthIssue): string | undefined => {
    const reason = ReasonSchema.safeParse(issue.payload?.[`reason`]);
    return reason.success ? reason.data : undefined;
};

// Guidance for the reader of the row: a person's for a step, an agent's for a fix, whichever PostHog gave otherwise.
const adviceFor = (lane: FindingLane, detail: HealthIssueDetail | undefined): string | undefined => {
    const remediation = detail?.remediation;
    return lane === `step` ? (remediation?.human ?? remediation?.agent) : (remediation?.agent ?? remediation?.human);
};

const healthFinding = (ctx: SourceContext, issue: HealthIssue, detail: HealthIssueDetail | undefined): Finding => {
    const lane = healthLane(issue.kind, detail);
    return finding(
        ctx,
        {
            source: `health`,
            sourceId: issue.id,
            kind: issue.kind,
            lane,
            severity: severityOf(issue.severity),
            title: detail?.title ?? kindWords(issue.kind),
            summary: detail?.summary ?? reasonOf(issue) ?? ``,
            path: detail?.link ?? `/health`,
            actions: lane === `fix` ? [`fix`, `resolve`, `snooze`] : [`resolve`, `snooze`],
        },
        {
            advice: adviceFor(lane, detail),
            since: msOf(issue.created_at),
            snoozedUntil: msOf(issue.snoozed_until),
            untrusted: evidence({ title: detail?.title, summary: detail?.summary, payload: issue.payload === undefined ? undefined : JSON.stringify(issue.payload) }),
        },
    );
};

export const healthFindings = (ctx: SourceContext, issues: readonly HealthIssue[], details: ReadonlyMap<string, HealthIssueDetail>): Finding[] =>
    issues.filter((issue) => issue.status === `active` && issue.dismissed !== true).map((issue) => healthFinding(ctx, issue, details.get(issue.id)));

// ---- error tracking --------------------------------------------------------------------------------------------------

const impactOf = (issue: ErrorIssue): Impact | undefined => {
    const read = issue.aggregations;
    if (read === undefined) {
        return undefined;
    }
    const impact: Record<string, number> = {};
    for (const key of [`occurrences`, `users`, `sessions`] as const) {
        const value = read[key];
        if (value !== undefined) {
            impact[key] = value;
        }
    }
    return impact;
};

export const errorSeverity = (issue: ErrorIssue, cameBack: boolean, now: number): FindingSeverity => {
    if (issue.severity === `critical` || cameBack) {
        return `critical`;
    }
    const firstSeen = msOf(issue.first_seen);
    return issue.severity === `high` || (firstSeen !== undefined && now - firstSeen < NEW_FOR_MS) ? `warning` : `info`;
};

// Which of the most frequent active errors become rows: the top few always, then any that is new or came back.
export const errorsWorthShowing = (ctx: SourceContext, issues: readonly ErrorIssue[]): ErrorIssue[] =>
    issues.filter((issue, rank) => {
        const firstSeen = msOf(issue.first_seen);
        return rank < TOP_ERRORS || ctx.resolved[findingId(ctx.connection, `error`, issue.id)] !== undefined || (firstSeen !== undefined && ctx.now - firstSeen < NEW_FOR_MS);
    });

const frameWords = (detail: ErrorIssueDetail | undefined): string | undefined => {
    const frame = detail?.top_in_app_frame;
    if (frame?.source === undefined) {
        return undefined;
    }
    return `${frame.function ?? `(anonymous)`} at ${frame.source}${frame.line === undefined ? `` : `:${frame.line}`}`;
};

export const errorFindings = (ctx: SourceContext, issues: readonly ErrorIssue[], details: ReadonlyMap<string, ErrorIssueDetail>): Finding[] =>
    errorsWorthShowing(ctx, issues).map((issue) => {
        const id = findingId(ctx.connection, `error`, issue.id);
        const resolvedAt = ctx.resolved[id];
        const lastSeen = msOf(issue.last_seen);
        // Marked fixed here, and seen again since: the fix did not hold.
        const cameBack = resolvedAt !== undefined && (lastSeen === undefined || lastSeen > resolvedAt);
        const detail = details.get(issue.id);
        const release = detail?.latest_release;
        return finding(
            ctx,
            {
                source: `error`,
                sourceId: issue.id,
                kind: issue.library ?? `error`,
                lane: `fix`,
                severity: errorSeverity(issue, cameBack, ctx.now),
                title: issue.name ?? `Unnamed exception`,
                summary: issue.description ?? ``,
                path: `/error_tracking/${issue.id}`,
                actions: [`fix`, `resolve`, `snooze`],
            },
            {
                impact: impactOf(issue),
                since: msOf(issue.first_seen),
                lastSeen,
                cameBack: cameBack ? true : undefined,
                untrusted: evidence({
                    message: issue.description,
                    frame: frameWords(detail),
                    release: release === undefined ? undefined : [release.version, release.commit_id, release.repo_name].filter(Boolean).join(` · `),
                }),
            },
        );
    });

// ---- insight alerts --------------------------------------------------------------------------------------------------

export const alertLane = (state: string | undefined): FindingLane => {
    const word = state?.toLowerCase() ?? ``;
    if (word === `firing`) {
        return `fix`;
    }
    return word === `errored` || word === `broken` ? `setup` : `watch`;
};

export const alertFindings = (ctx: SourceContext, alerts: readonly Alert[]): Finding[] =>
    alerts
        .filter((alert) => alert.enabled !== false)
        .map((alert) => {
            const lane = alertLane(alert.state);
            return finding(
                ctx,
                {
                    source: `alert`,
                    sourceId: alert.id,
                    kind: alert.state ?? `unknown`,
                    lane,
                    severity: lane === `fix` ? `warning` : `info`,
                    title: alert.name ?? alert.insight?.name ?? `Insight alert`,
                    summary: alert.insight?.name ?? ``,
                    path: `/alerts?alert_type=insights&alert_id=${encodeURIComponent(alert.id)}`,
                    actions: lane === `fix` ? [`fix`, `snooze`] : [],
                },
                {
                    since: msOf(lane === `fix` ? alert.last_notified_at : alert.last_checked_at),
                    snoozedUntil: msOf(alert.snoozed_until),
                    untrusted: evidence({ insight: alert.insight?.name, description: alert.insight?.description }),
                },
            );
        });

// ---- the Inbox: PostHog's own clustered reports ---------------------------------------------------------------------

export const reportSeverity = (priority: string | undefined): FindingSeverity => {
    const rank = /^p([0-4])$/i.exec(priority ?? ``)?.[1];
    if (rank === undefined) {
        return `warning`;
    }
    return rank === `0` || rank === `1` ? `critical` : rank === `2` ? `warning` : `info`;
};

// A ready report nobody else holds is work; one waiting on a person is the owner's step; one another actor claimed, or
// with a pull request open, is being handled elsewhere and only watched. Everything earlier in PostHog's pipeline
// (potential, candidate, in progress) is not a finding yet.
export const reportLane = (report: Report, ourClaim: boolean): FindingLane | undefined => {
    if (report.status === `pending_input`) {
        return `step`;
    }
    if (report.status !== `ready`) {
        return undefined;
    }
    const heldElsewhere = (report.assignee?.claim_id !== undefined && !ourClaim) || report.implementation_pr_url !== undefined;
    return heldElsewhere ? `watch` : `fix`;
};

export const reportFindings = (ctx: SourceContext, reports: readonly Report[], claims: Readonly<Record<string, string>>): Finding[] =>
    reports.flatMap((report) => {
        const id = findingId(ctx.connection, `report`, report.id);
        const lane = reportLane(report, claims[id] !== undefined && claims[id] === report.assignee?.claim_id);
        if (lane === undefined) {
            return [];
        }
        return [
            finding(
                ctx,
                {
                    source: `report`,
                    sourceId: report.id,
                    kind: report.priority ?? report.status,
                    lane,
                    severity: reportSeverity(report.priority),
                    title: report.title ?? `Inbox report`,
                    summary: report.summary_lead ?? ``,
                    path: `/inbox/${encodeURIComponent(report.id)}`,
                    actions: lane === `fix` ? [`fix`, `resolve`, `snooze`] : [`snooze`],
                },
                {
                    since: msOf(report.created_at),
                    untrusted: evidence({ title: report.title, summary: report.summary_lead, pullRequest: report.implementation_pr_url }),
                },
            ),
        ];
    });

// ---- PostHog's setup advice ------------------------------------------------------------------------------------------

// What each recommendation type is, in this extension's words; PostHog's own meta is evidence, not prose.
const SETUP_TITLES = new Map([
    [`alerts`, `Error alerts are not wired`],
    [`source_maps`, `Stack traces are not symbolicated`],
    [`rate_limits`, `No ingestion rate limits are set`],
    [`issue_summaries`, `Issue summaries are off`],
    [`long_running_issues`, `Errors have been active for over a week`],
]);

// Uploading source maps is a change to the build, an agent's; the rest are settings in PostHog.
const SETUP_FIXABLE: ReadonlySet<string> = new Set([`source_maps`]);

export const setupFindings = (ctx: SourceContext, recommendations: readonly Recommendation[], wired: boolean): Finding[] =>
    recommendations
        .filter((item) => item.completed !== true && item.dismissed_at === undefined && item.status !== `computing`)
        // Wired here already: PostHog may not have recomputed yet, and the advice is done.
        .filter((item) => !(item.type === `alerts` && wired))
        .map((item) => {
            const actions: FindingAction[] = [];
            if (item.type === `alerts`) {
                actions.push(`wire`);
            }
            if (SETUP_FIXABLE.has(item.type)) {
                actions.push(`fix`);
            }
            actions.push(`dismiss`);
            return finding(
                ctx,
                {
                    source: `setup`,
                    sourceId: item.id,
                    kind: item.type,
                    lane: `setup`,
                    severity: `info`,
                    title: SETUP_TITLES.get(item.type) ?? kindWords(item.type),
                    summary: ``,
                    path: `/error_tracking`,
                    actions,
                },
                { untrusted: evidence({ meta: item.meta === undefined ? undefined : JSON.stringify(item.meta) }) },
            );
        });

// ---- experiments -----------------------------------------------------------------------------------------------------

// A running experiment past two weeks, or an ended one nobody concluded, asks for a product decision.
export const experimentFindings = (ctx: SourceContext, experiments: readonly Experiment[]): Finding[] =>
    experiments.flatMap((experiment) => {
        const started = msOf(experiment.start_date);
        const ended = msOf(experiment.end_date);
        if (experiment.archived === true || experiment.deleted === true || experiment.conclusion !== undefined || started === undefined) {
            return [];
        }
        if (ended === undefined && ctx.now - started < EXPERIMENT_DECIDE_MS) {
            return [];
        }
        return [
            finding(
                ctx,
                {
                    source: `experiment`,
                    sourceId: experiment.id,
                    kind: ended === undefined ? `running` : `ended`,
                    lane: `decide`,
                    severity: `info`,
                    title: experiment.name ?? `Experiment ${experiment.id}`,
                    summary: experiment.feature_flag_key ?? ``,
                    path: `/experiments/${encodeURIComponent(experiment.id)}`,
                    actions: [`fix`, `snooze`],
                },
                { since: started, lastSeen: ended, untrusted: evidence({ name: experiment.name, flag: experiment.feature_flag_key }) },
            ),
        ];
    });
