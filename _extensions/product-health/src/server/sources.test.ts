import { AlertSchema, type ErrorIssue, ExperimentSchema, type HealthIssue, type HealthIssueDetail, type Recommendation, type Report } from "./posthog.js";
import {
    alertFindings,
    alertLane,
    errorFindings,
    errorSeverity,
    experimentFindings,
    findingId,
    healthFindings,
    healthLane,
    reportFindings,
    reportLane,
    reportSeverity,
    type SourceContext,
    setupFindings,
} from "./sources.js";

const NOW = Date.parse(`2026-11-26T12:00:00Z`);
const DAY = 24 * 60 * 60_000;
const ctx = (resolved: Record<string, number> = {}): SourceContext => ({ connection: `analytics`, host: `https://us.posthog.com/`, projectId: `503597`, now: NOW, resolved });
const iso = (ms: number): string => new Date(ms).toISOString();

// The four health issues the owner's own project had on 2026-11-26, as PostHog listed them.
const sdkOutdated: HealthIssue = {
    id: `01a1b008`,
    kind: `sdk_outdated`,
    severity: `critical`,
    status: `active`,
    dismissed: false,
    snoozed_until: undefined,
    payload: { sdk_name: `web`, current_version: `1.436.1`, latest_version: `1.455.2`, reason: `Latest in-use version 1.436.1 is behind 1.455.2 (51 days old).` },
    created_at: `2026-11-06T08:44:56Z`,
    updated_at: undefined,
};
const authorizedUrls: HealthIssue = { ...sdkOutdated, id: `019f42e1`, kind: `authorized_urls`, severity: `warning`, payload: { reason: `No authorized URLs configured.` } };
const sdkDetail: HealthIssueDetail = {
    ...sdkOutdated,
    title: `web SDK is outdated`,
    summary: `Latest in-use version 1.436.1 is behind 1.455.2.`,
    link: `/health/sdk-health`,
    remediation: { human: `Open the SDK Health page.`, agent: `Update the PostHog SDK dependency in the relevant manifest.` },
};

describe(`health checks`, () => {
    test(`an outdated SDK is an agent's fix, carrying PostHog's own guidance for an agent and its page on the real host`, () => {
        const [finding] = healthFindings(ctx(), [sdkOutdated], new Map([[sdkOutdated.id, sdkDetail]]));
        expect(finding).toMatchObject({
            id: `analytics:health:01a1b008`,
            lane: `fix`,
            severity: `critical`,
            title: `web SDK is outdated`,
            advice: `Update the PostHog SDK dependency in the relevant manifest.`,
            link: `https://us.posthog.com/project/503597/health/sdk-health`,
            actions: [`fix`, `resolve`, `snooze`],
        });
        // The headline and payload may carry project-supplied values: evidence, fenced, never the advice.
        expect(finding?.untrusted[`payload`]).toContain(`1.436.1`);
    });

    test(`a PostHog project setting is the owner's step, and reads from the payload's reason before the detail is read`, () => {
        const [finding] = healthFindings(ctx(), [authorizedUrls], new Map());
        expect(finding).toMatchObject({ lane: `step`, title: `Authorized urls`, summary: `No authorized URLs configured.`, actions: [`resolve`, `snooze`] });
    });

    test(`a check PostHog gives a person's guidance and no agent's is a step too`, () => {
        expect(healthLane(`something_new`, { ...sdkDetail, remediation: { human: `Click here in PostHog.`, agent: undefined } })).toBe(`step`);
        expect(healthLane(`something_new`, undefined)).toBe(`fix`);
        expect(healthLane(`data_warehouse_sync_failed`, undefined)).toBe(`step`);
    });

    test(`a dismissed or resolved check is no finding`, () => {
        expect(healthFindings(ctx(), [{ ...sdkOutdated, dismissed: true }, { ...sdkOutdated, status: `resolved` }], new Map())).toEqual([]);
    });
});

const error = (id: string, overrides: Partial<ErrorIssue> = {}): ErrorIssue => ({
    id,
    name: `TypeError`,
    description: `Cannot read properties of undefined (reading 'id')`,
    status: `active`,
    severity: undefined,
    first_seen: iso(NOW - 30 * DAY),
    last_seen: iso(NOW - DAY),
    library: `web`,
    source: undefined,
    aggregations: { occurrences: 120, users: 14, sessions: 20 },
    ...overrides,
});

describe(`errors`, () => {
    test(`the five most frequent always show; past them only a new one or one that came back does`, () => {
        const issues = [...[1, 2, 3, 4, 5, 6].map((n) => error(`e${n}`)), error(`fresh`, { first_seen: iso(NOW - DAY) })];
        expect(errorFindings(ctx(), issues, new Map()).map((finding) => finding.sourceId)).toEqual([`e1`, `e2`, `e3`, `e4`, `e5`, `fresh`]);
    });

    test(`one marked fixed here and seen since came back, and is the loudest kind of error`, () => {
        const id = findingId(`analytics`, `error`, `e1`);
        const [finding] = errorFindings(ctx({ [id]: NOW - 2 * DAY }), [error(`e1`)], new Map());
        expect(finding).toMatchObject({ cameBack: true, severity: `critical`, impact: { occurrences: 120, users: 14, sessions: 20 } });
    });

    test(`marked fixed and not seen since has not come back`, () => {
        const id = findingId(`analytics`, `error`, `e1`);
        const [finding] = errorFindings(ctx({ [id]: NOW - DAY / 2 }), [error(`e1`)], new Map());
        expect(finding?.cameBack).toBeUndefined();
    });

    test(`severity: PostHog's own word first, then new is a warning and old is information`, () => {
        expect(errorSeverity(error(`a`, { severity: `critical` }), false, NOW)).toBe(`critical`);
        expect(errorSeverity(error(`a`, { severity: `high` }), false, NOW)).toBe(`warning`);
        expect(errorSeverity(error(`a`, { first_seen: iso(NOW - DAY) }), false, NOW)).toBe(`warning`);
        expect(errorSeverity(error(`a`), false, NOW)).toBe(`info`);
    });

    test(`the exception's message and top frame are evidence from a user's browser`, () => {
        const detail = { ...error(`e1`), function: `load`, top_in_app_frame: { function: `load`, source: `src/app/load.ts`, line: 42, in_app: true }, latest_release: undefined };
        const [finding] = errorFindings(ctx(), [error(`e1`)], new Map([[`e1`, detail]]));
        expect(finding?.untrusted).toEqual({ message: `Cannot read properties of undefined (reading 'id')`, frame: `load at src/app/load.ts:42` });
    });
});

describe(`insight alerts`, () => {
    test(`firing is a fix, a broken alert is setup, anything else is watched`, () => {
        expect(alertLane(`Firing`)).toBe(`fix`);
        expect(alertLane(`Errored`)).toBe(`setup`);
        expect(alertLane(`Not firing`)).toBe(`watch`);
        expect(alertLane(undefined)).toBe(`watch`);
    });

    test(`a disabled alert is no finding, and the link opens the alert in PostHog`, () => {
        const alerts = [
            { id: `a1`, name: `Free trial refused a real user's turn`, state: `Not firing`, enabled: true },
            { id: `a2`, name: `Off`, state: `Firing`, enabled: false },
        ].map((alert) => AlertSchema.parse(alert));
        const findings = alertFindings(ctx(), alerts);
        expect(findings).toHaveLength(1);
        expect(findings[0]).toMatchObject({ lane: `watch`, actions: [], link: `https://us.posthog.com/project/503597/alerts?alert_type=insights&alert_id=a1` });
    });
});

const report = (overrides: Partial<Report> = {}): Report => ({
    id: `r1`,
    title: `Checkout button does nothing on Safari`,
    summary_lead: `Users on Safari 17 click Pay and nothing happens.`,
    status: `ready`,
    priority: `P1`,
    created_at: iso(NOW - DAY),
    updated_at: undefined,
    implementation_pr_url: undefined,
    repo_slug: undefined,
    source_products: [`session_replay`],
    assignee: undefined,
    ...overrides,
});

describe(`Inbox reports`, () => {
    test(`ready and unclaimed is work; waiting on a person is the owner's step; claimed elsewhere is watched; earlier is nothing`, () => {
        expect(reportLane(report(), false)).toBe(`fix`);
        expect(reportLane(report({ status: `pending_input` }), false)).toBe(`step`);
        expect(reportLane(report({ assignee: { claim_id: `c9`, kind: `user`, agent: undefined } }), false)).toBe(`watch`);
        expect(reportLane(report({ assignee: { claim_id: `c9`, kind: `agent`, agent: `intentic` } }), true)).toBe(`fix`);
        expect(reportLane(report({ implementation_pr_url: `https://github.com/o/r/pull/1` }), false)).toBe(`watch`);
        expect(reportLane(report({ status: `candidate` }), false)).toBeUndefined();
    });

    test(`priority sets severity, and this sandbox's own claim keeps the report its own work`, () => {
        expect([`P0`, `P1`, `P2`, `P3`, `P4`, undefined].map(reportSeverity)).toEqual([`critical`, `critical`, `warning`, `info`, `info`, `warning`]);
        const claimed = report({ assignee: { claim_id: `mine`, kind: `agent`, agent: `intentic` } });
        expect(reportFindings(ctx(), [claimed], { [findingId(`analytics`, `report`, `r1`)]: `mine` })[0]?.lane).toBe(`fix`);
    });
});

describe(`setup advice`, () => {
    const recommendation = (type: string, overrides: Partial<Recommendation> = {}): Recommendation => ({
        id: type,
        type,
        completed: false,
        status: `ready`,
        dismissed_at: undefined,
        meta: undefined,
        ...overrides,
    });

    test(`unwired alerts offer to wire them here; source maps are an agent's; done, dismissed or computing ones are not shown`, () => {
        const findings = setupFindings(
            ctx(),
            [recommendation(`alerts`), recommendation(`source_maps`), recommendation(`rate_limits`, { completed: true }), recommendation(`issue_summaries`, { status: `computing` })],
            false,
        );
        expect(findings.map((finding) => [finding.kind, finding.actions])).toEqual([
            [`alerts`, [`wire`, `dismiss`]],
            [`source_maps`, [`fix`, `dismiss`]],
        ]);
    });

    test(`alerts already posting here are done, whatever PostHog has computed yet`, () => {
        expect(setupFindings(ctx(), [recommendation(`alerts`)], true)).toEqual([]);
    });
});

describe(`experiments`, () => {
    test(`one running past two weeks, or ended without a conclusion, asks for a decision; a young, concluded or archived one does not`, () => {
        const experiments = [
            { id: `1`, name: `Pricing page v2`, start_date: iso(NOW - 20 * DAY), end_date: undefined },
            { id: `2`, name: `Young`, start_date: iso(NOW - 3 * DAY), end_date: undefined },
            { id: `3`, name: `Ended`, start_date: iso(NOW - 40 * DAY), end_date: iso(NOW - 10 * DAY) },
            { id: `4`, name: `Concluded`, start_date: iso(NOW - 40 * DAY), end_date: iso(NOW - 10 * DAY), conclusion: `won` },
            { id: `5`, name: `Archived`, start_date: iso(NOW - 40 * DAY), archived: true },
            { id: `6`, name: `Draft`, start_date: undefined },
        ].map((experiment) => ExperimentSchema.parse(experiment));
        expect(experimentFindings(ctx(), experiments).map((finding) => [finding.sourceId, finding.kind, finding.lane])).toEqual([
            [`1`, `running`, `decide`],
            [`3`, `ended`, `decide`],
        ]);
    });
});
