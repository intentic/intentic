import type { Finding } from "../wire.js";
import type { Workspace } from "./joins.js";
import { pollConnection, type Transition, transitionsOf, wiredHere } from "./poller.js";
import { type ErrorIssue, type HealthIssue, HogFunctionSchema, type PostHogClient, PostHogError } from "./posthog.js";
import { freshState, type State, type StateDocument } from "./state.js";

const DAY = 24 * 60 * 60_000;
const NOW = Date.parse(`2026-11-26T12:00:00Z`);

const memoryState = (initial: State = freshState()): StateDocument & { readonly current: () => State } => {
    let held = initial;
    return {
        read: async () => held,
        update: async (change) => {
            held = change(held);
            return held;
        },
        current: () => held,
    };
};

const noWorkspace: Workspace = { repos: async () => [], dirOf: (repo) => repo, git: async () => ``, read: async () => `` };

const sdk: HealthIssue = {
    id: `h1`,
    kind: `sdk_outdated`,
    severity: `critical`,
    status: `active`,
    dismissed: false,
    snoozed_until: undefined,
    payload: { sdk_name: `web`, current_version: `1.436.1` },
    created_at: `2026-11-06T08:44:56Z`,
    updated_at: undefined,
};
const error = (id: string): ErrorIssue => ({
    id,
    name: `TypeError`,
    description: `boom`,
    status: `active`,
    severity: undefined,
    first_seen: new Date(NOW - 2 * DAY).toISOString(),
    last_seen: new Date(NOW - DAY).toISOString(),
    library: `web`,
    source: undefined,
    aggregations: { occurrences: 3, users: 2, sessions: 2 },
});

// A PostHog that answers what the test says and refuses the rest, counting every detail read.
const clientOf = (lists: { health?: HealthIssue[]; errors?: ErrorIssue[]; failExperiments?: boolean }) => {
    const reads: string[] = [];
    const client: PostHogClient = {
        project: async () => ({ id: `503597`, name: `Default project` }),
        healthIssues: async () => lists.health ?? [],
        healthIssue: async (id) => {
            reads.push(`health:${id}`);
            return { ...sdk, id, title: `web SDK is outdated`, summary: `behind`, link: `/health/sdk-health`, remediation: { human: `h`, agent: `a` } };
        },
        errorIssues: async () => lists.errors ?? [],
        errorIssue: async (id) => {
            reads.push(`error:${id}`);
            return { ...error(id), function: undefined, top_in_app_frame: undefined, latest_release: undefined };
        },
        alerts: async () => [],
        reports: async () => [],
        recommendations: async () => [],
        experiments: async () => {
            if (lists.failExperiments === true) {
                throw new PostHogError(403, `PostHog answered 403: experiment:read is missing`);
            }
            return [];
        },
        alertDestinations: async () => [],
        resolveError: async () => undefined,
        resolveHealth: async () => undefined,
        snoozeHealth: async () => undefined,
        dismissRecommendation: async () => undefined,
        claimReport: async () => undefined,
        resolveReport: async () => undefined,
        createWebhookAlert: async () => undefined,
    };
    return { client, reads };
};

const round = async (state: StateDocument, client: PostHogClient, now = NOW) => {
    const woke: [string, Transition][] = [];
    await pollConnection(
        {
            daemon: { connection: async (id) => ({ id, host: `https://us.posthog.com`, apiKey: `k`, projectId: `` }) },
            clientOf: () => client,
            workspace: noWorkspace,
            state,
            now: () => now,
            log: () => undefined,
            transitioned: (finding, transition) => woke.push([finding.id, transition]),
        },
        `analytics`,
    );
    return woke;
};

describe(`a round`, () => {
    test(`writes the findings with the detail read once, says what it could not read, and wakes nobody the first time`, async () => {
        const state = memoryState();
        const { client, reads } = clientOf({ health: [sdk], errors: [error(`e1`)], failExperiments: true });
        expect(await round(state, client)).toEqual([]);
        const held = state.current();
        expect(held.findings[`analytics`]?.map((finding) => [finding.id, finding.lane, finding.title])).toEqual([
            [`analytics:health:h1`, `fix`, `web SDK is outdated`],
            [`analytics:error:e1`, `fix`, `TypeError`],
        ]);
        expect(held.connections[`analytics`]).toMatchObject({ project: `Default project`, projectId: `503597`, wired: false, problems: [{ source: `experiment` }] });
        expect(reads).toEqual([`health:h1`, `error:e1`]);
        // The next round reads no detail it holds.
        await round(state, client, NOW + 60_000);
        expect(reads).toEqual([`health:h1`, `error:e1`]);
    });

    test(`a later round wakes on what appeared, once`, async () => {
        const state = memoryState();
        await round(state, clientOf({ errors: [error(`e1`)] }).client);
        const next = clientOf({ errors: [error(`e1`), error(`e2`)], health: [sdk] }).client;
        expect(await round(state, next, NOW + 60_000)).toEqual([
            [`analytics:health:h1`, `health_problem`],
            [`analytics:error:e2`, `error_new`],
        ]);
        expect(await round(state, next, NOW + 120_000)).toEqual([]);
    });

    test(`a refused key reads as the connection's problem and leaves the last findings alone`, async () => {
        const state = memoryState();
        await round(state, clientOf({ errors: [error(`e1`)] }).client);
        const refused = { ...clientOf({}).client, project: async () => { throw new PostHogError(401, `PostHog answered 401: invalid key`); } };
        await round(state, refused, NOW + 60_000);
        expect(state.current().connections[`analytics`]?.problems).toEqual([{ source: `connection`, message: `PostHog answered 401: invalid key` }]);
        expect(state.current().findings[`analytics`]).toHaveLength(1);
    });
});

describe(`transitions`, () => {
    const base = (overrides: Partial<Finding>): Finding => ({
        id: `x`,
        connection: `c`,
        source: `alert`,
        sourceId: `x`,
        kind: `Firing`,
        lane: `fix`,
        severity: `warning`,
        title: `t`,
        summary: ``,
        link: ``,
        code: [],
        untrusted: {},
        actions: [],
        ...overrides,
    });

    test(`an alert that starts firing, an error that comes back and a report that becomes ready each wake once`, () => {
        const before = [base({ id: `a`, lane: `watch` }), base({ id: `e`, source: `error` }), base({ id: `r`, source: `report`, lane: `watch` })];
        const after = [base({ id: `a` }), base({ id: `e`, source: `error`, cameBack: true }), base({ id: `r`, source: `report` })];
        const seen = { a: 1, e: 1, r: 1 };
        expect(transitionsOf(before, after, seen).map(([finding, transition]) => [finding.id, transition])).toEqual([
            [`a`, `alert_firing`],
            [`e`, `error_back`],
            [`r`, `report_ready`],
        ]);
        expect(transitionsOf(after, after, seen)).toEqual([]);
    });
});

describe(`wired here`, () => {
    test(`every lifecycle event needs an enabled destination posting to this backend's token`, () => {
        const to = (event: string, url: string, enabled = true) => HogFunctionSchema.parse({ id: event, enabled, inputs: { url: { value: url } }, filters: { events: [{ id: event }] } });
        const here = `https://sandbox.example/door/intentic.product-health/hook/tok`;
        const all = [`$error_tracking_issue_created`, `$error_tracking_issue_reopened`, `$error_tracking_issue_spiking`].map((event) => to(event, here));
        expect(wiredHere(all, `tok`)).toBe(true);
        expect(wiredHere(all.slice(1), `tok`)).toBe(false);
        expect(wiredHere(all, `other`)).toBe(false);
        expect(wiredHere([...all.slice(1), to(`$error_tracking_issue_created`, here, false)], `tok`)).toBe(false);
    });
});
