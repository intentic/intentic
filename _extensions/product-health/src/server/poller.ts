import { errorMessage } from "@intentic/base/errors";
import { z } from "zod";
import type { CodeLink, ConnectionProblem, ConnectionState, Finding } from "../wire.js";
import type { HealthDaemon } from "./daemon.js";
import { frameLink, releaseLink, sdkPins, type Workspace } from "./joins.js";
import {
    type Alert,
    ERROR_TRACKING_EVENTS,
    type ErrorIssue,
    type ErrorIssueDetail,
    type Experiment,
    type HealthIssue,
    type HealthIssueDetail,
    type HogFunction,
    type PostHogClient,
    type PostHogConnection,
    type Recommendation,
    type Report,
} from "./posthog.js";
import { alertFindings, errorFindings, errorsWorthShowing, experimentFindings, healthFindings, reportFindings, type SourceContext, setupFindings } from "./sources.js";
import { DETAIL_TTL_MS, type ErrorDetail, type HealthDetail, pruned, type State, type StateDocument } from "./state.js";

/* ONE ROUND OF READING POSTHOG, per connection: every list once, then the details this backend has not read yet (a health
   check's guidance, an error's top frame and release), bounded so one round never spends more than a handful of
   PostHog's organisation-wide budget, then where each finding points in the workspace, then what changed since the last
   round, which wakes the automations listening (wake.ts). A source that fails is said on the connection and leaves the
   rest standing: a 403 on experiments must not blank the errors. */

// How many errors one round asks PostHog for; errorsWorthShowing keeps the top few and the new.
const ERRORS_READ = 20;
// The most details read in one round, per kind; the rest wait for the next round.
const DETAILS_PER_ROUND = 5;

// What changed in a round that an automation may want to hear, by the listener's event types (the manifest's).
export type Transition = `error_new` | `error_back` | `alert_firing` | `health_problem` | `report_ready`;

export interface PollDeps {
    readonly daemon: Pick<HealthDaemon, `connection`>;
    readonly clientOf: (connection: PostHogConnection) => PostHogClient;
    readonly workspace: Workspace;
    readonly state: StateDocument;
    readonly now: () => number;
    readonly log: (message: string) => void;
    // Told each finding that appeared or turned in this round, after the state holding it is written.
    readonly transitioned: (finding: Finding, transition: Transition) => void;
}

interface Read<T> {
    readonly value: T;
    readonly problem?: ConnectionProblem | undefined;
}

const settle = async <T>(source: ConnectionProblem[`source`], fallback: T, read: () => Promise<T>): Promise<Read<T>> => {
    try {
        return { value: await read() };
    } catch (error) {
        return { value: fallback, problem: { source, message: errorMessage(error) } };
    }
};

// The details worth reading this round: never read, or read before the issue last changed, or read long ago.
const staleKeys = <T extends { readonly at: number }>(keys: readonly { readonly key: string; readonly changed: number | undefined }[], held: Readonly<Record<string, T>>, now: number): string[] =>
    keys
        .filter(({ key, changed }) => {
            const detail = held[key];
            return detail === undefined || now - detail.at > DETAIL_TTL_MS || (changed !== undefined && changed > detail.at);
        })
        .slice(0, DETAILS_PER_ROUND)
        .map(({ key }) => key);

const msOf = (iso: string | undefined): number | undefined => (iso === undefined ? undefined : Date.parse(iso) || undefined);

const healthDetailOf = (detail: HealthIssueDetail, now: number): HealthDetail => ({
    at: now,
    title: detail.title,
    summary: detail.summary,
    link: detail.link,
    human: detail.remediation?.human,
    agent: detail.remediation?.agent,
});

const errorDetailOf = (detail: ErrorIssueDetail, now: number): ErrorDetail => {
    const frame = detail.top_in_app_frame;
    const release = detail.latest_release;
    return {
        at: now,
        frame: frame?.source === undefined ? undefined : { function: frame.function, source: frame.source, line: frame.line },
        release: release === undefined ? undefined : { version: release.version, commit: release.commit_id, repo: release.repo_name },
    };
};

// A held detail, back in the shape sources.ts reads it in.
const asHealthDetail = (issue: HealthIssue, held: HealthDetail | undefined): HealthIssueDetail | undefined =>
    held === undefined
        ? undefined
        : { ...issue, title: held.title, summary: held.summary, link: held.link, remediation: held.human === undefined && held.agent === undefined ? undefined : { human: held.human, agent: held.agent } };

const asErrorDetail = (issue: ErrorIssue, held: ErrorDetail | undefined): ErrorIssueDetail | undefined =>
    held === undefined
        ? undefined
        : {
              ...issue,
              function: held.frame?.function,
              top_in_app_frame: held.frame === undefined ? undefined : { function: held.frame.function, source: held.frame.source, line: held.frame.line, in_app: true },
              latest_release:
                  held.release === undefined
                      ? undefined
                      : { version: held.release.version, commit_id: held.release.commit, repo_name: held.release.repo, branch: undefined, project: undefined },
          };

// Whether one of PostHog's alert destinations posts this lifecycle event to this sandbox's door: enabled, and its address
// carrying this backend's token.
export const postsHere = (destination: HogFunction, event: string, token: string): boolean =>
    destination.enabled !== false &&
    destination.deleted !== true &&
    destination.filters?.events?.some((each) => each.id === event) === true &&
    JSON.stringify(destination.inputs ?? {}).includes(`/hook/${token}`);

// Whether PostHog's error-tracking alerts already post to this sandbox: every lifecycle event has a destination here.
export const wiredHere = (destinations: readonly HogFunction[], token: string): boolean =>
    ERROR_TRACKING_EVENTS.every((event) => destinations.some((destination) => postsHere(destination, event, token)));

// What turned in one finding since the last round, by its source. `prior` is the same finding a round ago; `fresh` says
// it was never seen before.
type Turn = (finding: Finding, prior: Finding | undefined, fresh: boolean) => Transition | undefined;
const TURNS = {
    error: (finding, prior, fresh) => (finding.cameBack === true && prior?.cameBack !== true ? `error_back` : fresh ? `error_new` : undefined),
    alert: (finding, prior) => (finding.lane === `fix` && prior?.lane !== `fix` ? `alert_firing` : undefined),
    health: (finding, _prior, fresh) => (fresh && (finding.lane === `fix` || finding.lane === `step`) ? `health_problem` : undefined),
    report: (finding, prior) => (finding.lane === `fix` && prior?.lane !== `fix` ? `report_ready` : undefined),
    setup: () => undefined,
    experiment: () => undefined,
} satisfies Record<Finding[`source`], Turn>;

// What appeared or turned since the last round. A connection's first round only learns what is there: an install must
// not wake an agent on every problem the project already had.
export const transitionsOf = (previous: readonly Finding[] | undefined, current: readonly Finding[], seen: Readonly<Record<string, number>>): [Finding, Transition][] => {
    if (previous === undefined) {
        return [];
    }
    const before = new Map(previous.map((finding) => [finding.id, finding]));
    return current.flatMap((finding): [Finding, Transition][] => {
        const transition = TURNS[finding.source](finding, before.get(finding.id), seen[finding.id] === undefined);
        return transition === undefined ? [] : [[finding, transition]];
    });
};

interface Lists {
    readonly health: Read<readonly HealthIssue[]>;
    readonly errors: Read<readonly ErrorIssue[]>;
    readonly alerts: Read<readonly Alert[]>;
    readonly reports: Read<readonly Report[]>;
    readonly recommendations: Read<readonly Recommendation[]>;
    readonly experiments: Read<readonly Experiment[]>;
    readonly destinations: Read<readonly HogFunction[]>;
}

const readLists = async (client: PostHogClient): Promise<Lists> => {
    const [health, errors, alerts, reports, recommendations, experiments, destinations] = await Promise.all([
        settle(`health`, [], () => client.healthIssues()),
        settle(`error`, [], () => client.errorIssues(ERRORS_READ)),
        settle(`alert`, [], () => client.alerts()),
        settle(`report`, [], () => client.reports()),
        settle(`setup`, [], () => client.recommendations()),
        settle(`experiment`, [], () => client.experiments()),
        settle(`setup`, [], () => client.alertDestinations()),
    ]);
    return { health, errors, alerts, reports, recommendations, experiments, destinations };
};

// Reads the details not held yet, each kept with when it was read; one that fails waits for the next round.
const readDetails = async (client: PostHogClient, connection: string, lists: Lists, state: State, ctx: SourceContext) => {
    const healthKeys = staleKeys(
        lists.health.value.map((issue) => ({ key: `${connection}:${issue.id}`, changed: msOf(issue.updated_at) })),
        state.healthDetails,
        ctx.now,
    );
    const errorKeys = staleKeys(
        errorsWorthShowing(ctx, lists.errors.value).map((issue) => ({ key: `${connection}:${issue.id}`, changed: undefined })),
        state.errorDetails,
        ctx.now,
    );
    const idOf = (key: string): string => key.slice(connection.length + 1);
    // allow(silent-catch): a detail PostHog would not serve this round is asked again next round; the row stands without it.
    const health = await Promise.all(healthKeys.map(async (key) => [key, await client.healthIssue(idOf(key)).catch(() => undefined)] as const));
    // allow(silent-catch): as above, for an error's top frame and release.
    const errors = await Promise.all(errorKeys.map(async (key) => [key, await client.errorIssue(idOf(key)).catch(() => undefined)] as const));
    const healthDetails = { ...state.healthDetails };
    for (const [key, detail] of health) {
        if (detail !== undefined) {
            healthDetails[key] = healthDetailOf(detail, ctx.now);
        }
    }
    const errorDetails = { ...state.errorDetails };
    for (const [key, detail] of errors) {
        if (detail !== undefined) {
            errorDetails[key] = errorDetailOf(detail, ctx.now);
        }
    }
    return { healthDetails, errorDetails };
};

// What an outdated-SDK check's payload names: which SDK, and the version still sending the most.
const SdkPayloadSchema = z.looseObject({ sdk_name: z.string(), current_version: z.string().optional() });

// Where one finding points: the SDK pin for an outdated SDK, an error's frame and release.
const linksOf = async (workspace: Workspace, finding: Finding, health: HealthIssue | undefined, error: ErrorDetail | undefined): Promise<CodeLink[]> => {
    if (health?.kind === `sdk_outdated`) {
        const payload = SdkPayloadSchema.safeParse(health.payload);
        return payload.success ? sdkPins(workspace, payload.data.sdk_name, payload.data.current_version) : [];
    }
    if (finding.source !== `error` || error === undefined) {
        return [];
    }
    const links: CodeLink[] = [];
    const frame = error.frame === undefined ? undefined : await frameLink(workspace, error.frame.source, error.frame.line);
    if (frame !== undefined) {
        links.push(frame);
    }
    const release = await releaseLink(workspace, error.release?.commit, error.release?.repo);
    if (release !== undefined && !links.some((link) => link.repo === release.repo)) {
        links.push(release);
    }
    return links;
};

// The details held for this round's lists, keyed by PostHog's issue id, as sources.ts reads them.
const heldHealth = (connection: string, issues: readonly HealthIssue[], held: Readonly<Record<string, HealthDetail>>): Map<string, HealthIssueDetail> =>
    new Map(
        issues.flatMap((issue) => {
            const detail = asHealthDetail(issue, held[`${connection}:${issue.id}`]);
            return detail === undefined ? [] : [[issue.id, detail] as const];
        }),
    );

const heldErrors = (connection: string, issues: readonly ErrorIssue[], held: Readonly<Record<string, ErrorDetail>>): Map<string, ErrorIssueDetail> =>
    new Map(
        issues.flatMap((issue) => {
            const detail = asErrorDetail(issue, held[`${connection}:${issue.id}`]);
            return detail === undefined ? [] : [[issue.id, detail] as const];
        }),
    );

// Each finding with where it points; a join that fails is logged and leaves the finding without links.
const withLinks = async (deps: PollDeps, findings: readonly Finding[], health: ReadonlyMap<string, HealthIssue>, errors: Readonly<Record<string, ErrorDetail>>): Promise<Finding[]> =>
    Promise.all(
        findings.map(async (finding) => {
            try {
                return { ...finding, code: await linksOf(deps.workspace, finding, health.get(finding.sourceId), errors[`${finding.connection}:${finding.sourceId}`]) };
            } catch (error) {
                deps.log(`could not work out where ${finding.id} points: ${errorMessage(error)}`);
                return finding;
            }
        }),
    );

/** One round for one connection, written to the state when it ends. */
export const pollConnection = async (deps: PollDeps, connectionId: string): Promise<void> => {
    const now = deps.now();
    let connection: PostHogConnection;
    try {
        connection = await deps.daemon.connection(connectionId);
    } catch (error) {
        await deps.state.update((state) => ({
            ...state,
            connections: { ...state.connections, [connectionId]: { id: connectionId, host: ``, polledAt: now, problems: [{ source: `connection`, message: errorMessage(error) }], wired: false } },
        }));
        return;
    }
    const client = deps.clientOf(connection);
    const project = await settle(`connection`, undefined, () => client.project());
    if (project.value === undefined) {
        // No project, no lists: a key PostHog refused answers every call the same way.
        await deps.state.update((state) => ({
            ...state,
            connections: { ...state.connections, [connectionId]: { id: connectionId, host: connection.host, polledAt: now, problems: project.problem === undefined ? [] : [project.problem], wired: false } },
        }));
        return;
    }
    const lists = await readLists(client);
    const held = await deps.state.read();
    const ctx: SourceContext = { connection: connectionId, host: connection.host, projectId: project.value.id, now, resolved: held.resolved };
    const details = await readDetails(client, connectionId, lists, held, ctx);
    const wired = wiredHere(lists.destinations.value, held.hookToken);
    const raw = [
        ...healthFindings(ctx, lists.health.value, heldHealth(connectionId, lists.health.value, details.healthDetails)),
        ...errorFindings(ctx, lists.errors.value, heldErrors(connectionId, lists.errors.value, details.errorDetails)),
        ...alertFindings(ctx, lists.alerts.value),
        ...reportFindings(ctx, lists.reports.value, held.claims),
        ...setupFindings(ctx, lists.recommendations.value, wired),
        ...experimentFindings(ctx, lists.experiments.value),
    ];
    const findings = await withLinks(deps, raw, new Map(lists.health.value.map((issue) => [issue.id, issue])), details.errorDetails);
    const problems = [project, ...Object.values(lists)].flatMap((read) => (read.problem === undefined ? [] : [read.problem]));
    const connectionState: ConnectionState = { id: connectionId, host: connection.host, project: project.value.name, projectId: project.value.id, polledAt: now, problems, wired };
    let turned: [Finding, Transition][] = [];
    await deps.state.update((state) => {
        turned = transitionsOf(state.connections[connectionId]?.polledAt === undefined ? undefined : state.findings[connectionId], findings, state.seen);
        const seen = { ...state.seen };
        for (const finding of findings) {
            seen[finding.id] ??= now;
        }
        return pruned(
            {
                ...state,
                seen,
                healthDetails: details.healthDetails,
                errorDetails: details.errorDetails,
                connections: { ...state.connections, [connectionId]: connectionState },
                findings: { ...state.findings, [connectionId]: findings },
            },
            now,
        );
    });
    for (const [finding, transition] of turned) {
        deps.transitioned(finding, transition);
    }
};

/** Forgets what the backend held for connections that are no longer on the Capabilities page. */
export const forgetGone = async (state: StateDocument, connections: readonly string[]): Promise<void> => {
    const live = new Set(connections);
    await state.update((current) => {
        const goneConnections = Object.keys(current.connections).filter((id) => !live.has(id));
        if (goneConnections.length === 0) {
            return current;
        }
        return {
            ...current,
            connections: Object.fromEntries(Object.entries(current.connections).filter(([id]) => live.has(id))),
            findings: Object.fromEntries(Object.entries(current.findings).filter(([id]) => live.has(id))),
        };
    });
};
