import { z } from "zod";

/* POSTHOG'S REST API, as much of it as Product health reads and writes. Every path here is the one PostHog's own
   agent CLI (`posthog-cli api`, the tool catalogue the posthog skill drives) calls for the same tool, recorded against a
   local stand-in on 2026-11-26, and every answer is PostHog's published OpenAPI schema narrowed to the fields read
   here. Parsed loosely (unknown fields kept, everything PostHog may leave out optional), so a field PostHog adds never
   fails a read; a field it renames shows as missing, not as a crash.

   Rate limits are per ORGANISATION, shared with everyone else using PostHog (240 analytics requests a minute, 2400
   queries an hour): the poller (poller.ts) is the only caller that loops, and it asks each list once a round. */

// How long one call may take before the poll gives up on that source for this round.
const CALL_TIMEOUT_MS = 20_000;

export interface PostHogConnection {
    readonly id: string;
    // The connection's own address (US cloud, EU cloud or an install of the owner's), never the credential gateway's.
    readonly host: string;
    readonly apiKey: string;
    // Empty: the project the key is scoped to, which the first call asks PostHog for.
    readonly projectId: string;
}

// A refusal PostHog answered, with its status, so a 401 reads as a key problem and a 429 as the organisation's budget.
export class PostHogError extends Error {
    constructor(
        readonly status: number,
        message: string,
    ) {
        super(message);
    }
}

const maybe = <T extends z.ZodType>(schema: T) => schema.nullish().transform((value) => value ?? undefined);
const id = z.union([z.number(), z.string()]).transform(String);

const ProjectSchema = z.looseObject({ id, name: maybe(z.string()) });
const MeSchema = z.looseObject({ team: maybe(z.looseObject({ id })) });

export const HealthIssueSchema = z.looseObject({
    id: z.string(),
    kind: z.string(),
    severity: z.string(),
    status: z.string(),
    dismissed: maybe(z.boolean()),
    snoozed_until: maybe(z.string()),
    payload: maybe(z.record(z.string(), z.json())),
    created_at: maybe(z.string()),
    updated_at: maybe(z.string()),
});
export type HealthIssue = z.infer<typeof HealthIssueSchema>;

// The detail adds PostHog's own headline, summary, page and guidance. Its `title` and `summary` may embed values a
// project or an event supplied; `remediation` is the one part PostHog authored itself.
export const HealthIssueDetailSchema = HealthIssueSchema.extend({
    title: maybe(z.string()),
    summary: maybe(z.string()),
    link: maybe(z.string()),
    remediation: maybe(z.looseObject({ human: maybe(z.string()), agent: maybe(z.string()) })),
});
export type HealthIssueDetail = z.infer<typeof HealthIssueDetailSchema>;

const AggregationsSchema = z.looseObject({ occurrences: maybe(z.number()), users: maybe(z.number()), sessions: maybe(z.number()) });

export const ErrorIssueSchema = z.looseObject({
    id: z.string(),
    name: maybe(z.string()),
    description: maybe(z.string()),
    status: z.string(),
    // PostHog's own severity when someone set one: a word, or an object holding it, depending on the install's version.
    severity: maybe(z.union([z.string(), z.looseObject({ value: maybe(z.string()) }).transform((held) => held.value)])),
    first_seen: maybe(z.string()),
    last_seen: maybe(z.string()),
    library: maybe(z.string()),
    source: maybe(z.string()),
    aggregations: maybe(AggregationsSchema),
});
export type ErrorIssue = z.infer<typeof ErrorIssueSchema>;

export const ErrorIssueDetailSchema = ErrorIssueSchema.extend({
    function: maybe(z.string()),
    top_in_app_frame: maybe(
        z.looseObject({ function: maybe(z.string()), source: maybe(z.string()), line: maybe(z.number()), in_app: maybe(z.boolean()) }),
    ),
    latest_release: maybe(
        z.looseObject({
            version: maybe(z.string()),
            commit_id: maybe(z.string()),
            branch: maybe(z.string()),
            repo_name: maybe(z.string()),
            project: maybe(z.string()),
        }),
    ),
});
export type ErrorIssueDetail = z.infer<typeof ErrorIssueDetailSchema>;

export const AlertSchema = z.looseObject({
    id: z.string(),
    name: maybe(z.string()),
    state: maybe(z.string()),
    enabled: maybe(z.boolean()),
    snoozed_until: maybe(z.string()),
    last_checked_at: maybe(z.string()),
    last_notified_at: maybe(z.string()),
    calculation_interval: maybe(z.string()),
    insight: maybe(z.looseObject({ short_id: maybe(z.string()), name: maybe(z.string()), description: maybe(z.string()) })),
});
export type Alert = z.infer<typeof AlertSchema>;

export const ReportSchema = z.looseObject({
    id: z.string(),
    title: maybe(z.string()),
    summary_lead: maybe(z.string()),
    status: z.string(),
    priority: maybe(z.string()),
    created_at: maybe(z.string()),
    updated_at: maybe(z.string()),
    implementation_pr_url: maybe(z.string()),
    repo_slug: maybe(z.string()),
    source_products: maybe(z.array(z.string())),
    assignee: maybe(z.looseObject({ claim_id: maybe(z.string()), kind: maybe(z.string()), agent: maybe(z.string()) })),
});
export type Report = z.infer<typeof ReportSchema>;

export const RecommendationSchema = z.looseObject({
    id: z.string(),
    type: z.string(),
    completed: maybe(z.boolean()),
    status: maybe(z.string()),
    dismissed_at: maybe(z.string()),
    meta: maybe(z.json()),
});
export type Recommendation = z.infer<typeof RecommendationSchema>;

export const ExperimentSchema = z.looseObject({
    id,
    name: maybe(z.string()),
    start_date: maybe(z.string()),
    end_date: maybe(z.string()),
    archived: maybe(z.boolean()),
    deleted: maybe(z.boolean()),
    feature_flag_key: maybe(z.string()),
    conclusion: maybe(z.string()),
});
export type Experiment = z.infer<typeof ExperimentSchema>;

export const HogFunctionSchema = z.looseObject({
    id: z.string(),
    name: maybe(z.string()),
    enabled: maybe(z.boolean()),
    deleted: maybe(z.boolean()),
    template_id: maybe(z.string()),
    inputs: maybe(z.record(z.string(), z.json())),
    filters: maybe(z.looseObject({ events: maybe(z.array(z.looseObject({ id: maybe(z.string()) }))) })),
});
export type HogFunction = z.infer<typeof HogFunctionSchema>;

// A page of rows; one row this version cannot read is dropped rather than failing the whole list.
const pageOf = <T extends z.ZodType>(row: T) =>
    z.looseObject({ results: z.array(row.optional().catch(undefined)) }).transform((read) => read.results.filter((item) => item !== undefined));

// Recommendations come as a bare list or as a page, depending on the install's version.
const RecommendationsSchema = z.union([z.array(RecommendationSchema.optional().catch(undefined)).transform((rows) => rows.filter((row) => row !== undefined)), pageOf(RecommendationSchema)]);

// What a claim answers: the report, whose assignee carries the claim id later updates name.
const ClaimSchema = z.looseObject({ assignee: maybe(z.looseObject({ claim_id: maybe(z.string()) })) });

// PostHog answers a refusal as `{ detail }` or `{ type, code, detail }`; the detail is its sentence.
const RefusalSchema = z.looseObject({ detail: z.string() });

// The three error-tracking lifecycle events an alert can fire on.
export const ERROR_TRACKING_EVENTS = [`$error_tracking_issue_created`, `$error_tracking_issue_reopened`, `$error_tracking_issue_spiking`] as const;

// A request body: JSON this module builds itself.
type Body = Readonly<Record<string, z.core.util.JSONType>>;

export interface ReportClaim {
    readonly claimId?: string | undefined;
    readonly release?: boolean | undefined;
}

export interface WebhookAlert {
    readonly name: string;
    readonly url: string;
    readonly event: string;
}

export interface PostHogClient {
    readonly project: () => Promise<{ readonly id: string; readonly name: string | undefined }>;
    readonly healthIssues: () => Promise<readonly HealthIssue[]>;
    readonly healthIssue: (issueId: string) => Promise<HealthIssueDetail>;
    readonly errorIssues: (limit: number) => Promise<readonly ErrorIssue[]>;
    readonly errorIssue: (issueId: string) => Promise<ErrorIssueDetail>;
    readonly alerts: () => Promise<readonly Alert[]>;
    readonly reports: () => Promise<readonly Report[]>;
    readonly recommendations: () => Promise<readonly Recommendation[]>;
    readonly experiments: () => Promise<readonly Experiment[]>;
    readonly alertDestinations: () => Promise<readonly HogFunction[]>;
    // Writes, each behind a person's press (routes.ts) or an agent's start on a report (fix.ts).
    readonly resolveError: (issueId: string) => Promise<void>;
    readonly resolveHealth: (issueId: string) => Promise<void>;
    readonly snoozeHealth: (issueId: string, until: Date) => Promise<void>;
    readonly dismissRecommendation: (recommendationId: string) => Promise<void>;
    readonly claimReport: (reportId: string, claim: ReportClaim) => Promise<string | undefined>;
    readonly resolveReport: (reportId: string) => Promise<void>;
    readonly createWebhookAlert: (alert: WebhookAlert) => Promise<void>;
}

export type Fetch = (input: string, init?: RequestInit) => Promise<Response>;

const refusalOf = async (response: Response): Promise<string> => {
    // allow(silent-catch): a refusal whose body cannot be read is said by its status and status text below.
    const text = await response.text().catch(() => ``);
    let parsed: z.ZodSafeParseResult<z.infer<typeof RefusalSchema>> | undefined;
    try {
        parsed = RefusalSchema.safeParse(JSON.parse(text));
    } catch {
        // allow(silent-catch): not JSON, so the text itself, cut, is the best account there is.
    }
    return parsed?.success === true ? parsed.data.detail : text.slice(0, 300) || response.statusText;
};

// Strips the trailing slash an owner may type, so `${host}/api/…` never doubles it.
const baseOf = (host: string): string => host.replace(/\/+$/, ``);

const headersFor = (apiKey: string, body: boolean): Headers => {
    const headers = new Headers({ authorization: `Bearer ${apiKey}`, accept: `application/json` });
    if (body) {
        headers.set(`content-type`, `application/json`);
    }
    return headers;
};

// A claim names the attempt it continues once PostHog handed one out; the first claim of a report names none.
const claimBody = (claim: ReportClaim): Body =>
    claim.claimId === undefined
        ? { takeover: false, release: claim.release === true }
        : { takeover: false, release: claim.release === true, claim_id: claim.claimId };

export const postHogClient = (connection: PostHogConnection, fetchFn: Fetch = fetch): PostHogClient => {
    const base = baseOf(connection.host);
    let projectId = connection.projectId.trim();

    const send = async (path: string, method: string, body?: Body): Promise<Response> => {
        const init: RequestInit = { method, headers: headersFor(connection.apiKey, body !== undefined), signal: AbortSignal.timeout(CALL_TIMEOUT_MS) };
        if (body !== undefined) {
            init.body = JSON.stringify(body);
        }
        const response = await fetchFn(`${base}${path}`, init);
        if (!response.ok) {
            throw new PostHogError(response.status, `PostHog answered ${response.status}: ${await refusalOf(response)}`);
        }
        return response;
    };
    const read = async <T extends z.ZodType>(schema: T, path: string, body?: Body): Promise<z.infer<T>> =>
        schema.parse(await (await send(path, body === undefined ? `GET` : `POST`, body)).json());

    const projectPath = async (path: string): Promise<string> => {
        if (projectId === ``) {
            const me = await read(MeSchema, `/api/users/@me/`);
            if (me.team === undefined) {
                throw new PostHogError(404, `this key names no project; set one under Advanced → Project ID on the PostHog card`);
            }
            projectId = me.team.id;
        }
        return `/api/projects/${projectId}${path}`;
    };
    const get = async <T extends z.ZodType>(schema: T, path: string): Promise<z.infer<T>> => read(schema, await projectPath(path));
    const post = async <T extends z.ZodType>(schema: T, path: string, body: Body): Promise<z.infer<T>> => read(schema, await projectPath(path), body);
    const write = async (method: string, path: string, body: Body): Promise<void> => {
        await send(await projectPath(path), method, body);
    };
    const one = (issueId: string): string => encodeURIComponent(issueId);

    return {
        project: async () => {
            const project = await get(ProjectSchema, `/`);
            return { id: project.id, name: project.name };
        },
        healthIssues: () => get(pageOf(HealthIssueSchema), `/health_issues/?status=active&limit=100`),
        healthIssue: (issueId) => get(HealthIssueDetailSchema, `/health_issues/${one(issueId)}/`),
        // Active issues seen in the last 7 days, most occurrences first, test accounts left out: PostHog's own defaults.
        errorIssues: (limit) =>
            post(pageOf(ErrorIssueSchema), `/error_tracking/query/issues/`, {
                status: `active`,
                filterTestAccounts: true,
                orderBy: `occurrences`,
                orderDirection: `DESC`,
                limit,
                offset: 0,
            }),
        errorIssue: (issueId) =>
            post(ErrorIssueDetailSchema, `/error_tracking/query/issue/`, {
                issueId,
                filterTestAccounts: true,
                volumeResolution: 0,
                includeSparkline: false,
                includeBreakdown: false,
            }),
        alerts: () => get(pageOf(AlertSchema), `/alerts/`),
        // Suppressed reports are hidden by PostHog's default; the rest are sorted out by status in sources.ts.
        reports: () => get(pageOf(ReportSchema), `/signals/reports/?limit=50&include_source_metadata=false`),
        recommendations: () => get(RecommendationsSchema, `/error_tracking/recommendations/`),
        experiments: () => get(pageOf(ExperimentSchema), `/experiments/?limit=100`),
        alertDestinations: () => get(pageOf(HogFunctionSchema), `/hog_functions/?type=internal_destination&limit=200`),
        resolveError: (issueId) => write(`PATCH`, `/error_tracking/issues/${one(issueId)}/`, { status: `resolved` }),
        resolveHealth: (issueId) => write(`POST`, `/health_issues/${one(issueId)}/resolve/`, {}),
        snoozeHealth: (issueId, until) => write(`PATCH`, `/health_issues/${one(issueId)}/`, { snoozed_until: until.toISOString() }),
        dismissRecommendation: (recommendationId) => write(`POST`, `/error_tracking/recommendations/${one(recommendationId)}/dismiss/`, {}),
        claimReport: async (reportId, claim) => (await post(ClaimSchema, `/signals/reports/${one(reportId)}/claim/`, claimBody(claim))).assignee?.claim_id,
        resolveReport: (reportId) => write(`POST`, `/signals/reports/${one(reportId)}/state/`, { state: `resolved`, dismissal_reason: `fixed_outside_posthog` }),
        createWebhookAlert: (alert) =>
            write(`POST`, `/hog_functions/`, {
                type: `internal_destination`,
                name: alert.name,
                enabled: true,
                template_id: `template-webhook`,
                inputs: { url: { value: alert.url } },
                filters: { source: `events`, events: [{ id: alert.event, type: `events` }] },
            }),
    };
};

// The page in PostHog a finding is read on, on the connection's own host: never the credential gateway's address, which
// `posthog-cli` hands back in its `_posthogUrl` and which opens nothing in the owner's browser.
export const postHogPage = (host: string, projectId: string, path: string): string => `${baseOf(host)}/project/${projectId}${path.startsWith(`/`) ? path : `/${path}`}`;
