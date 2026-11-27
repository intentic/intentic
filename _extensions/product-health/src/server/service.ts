import { errorMessage } from "@intentic/base/errors";
import type { ExtensionCaller, ExtensionHealth, RunSettled } from "@intentic/extension-api";
import type { Finding, FixRequest, Snapshot } from "../wire.js";
import { dismissFinding, resolveFinding, snoozeFinding, wireAlerts } from "./actions.js";
import { ownerStepOf } from "./brief.js";
import type { HealthDaemon } from "./daemon.js";
import { type FixOutcome, startFindingFix } from "./fix.js";
import type { Workspace } from "./joins.js";
import { forgetGone, pollConnection } from "./poller.js";
import type { PostHogClient, PostHogConnection } from "./posthog.js";
import { roundScheduler } from "./scheduler.js";
import { findingIn, snapshotOf } from "./snapshot.js";
import type { State, StateDocument } from "./state.js";
import { wakeOn } from "./wake.js";

/* THE BACKEND'S ONE SERVICE, which the view's routes, the agent's tools and the alert door all call: the rounds of
   reading PostHog (scheduler.ts), the snapshot, and the presses. */

const POLL_MS = 10 * 60_000;
const TIMING = { every: POLL_MS, gap: 30_000, first: 5_000 };

export interface ServiceDeps {
    readonly daemon: HealthDaemon;
    readonly state: StateDocument;
    readonly workspace: Workspace;
    readonly clientOf: (connection: PostHogConnection) => PostHogClient;
    readonly now: () => number;
    readonly log: (message: string) => void;
    // This extension's routing id, the `/door/<id>/` PostHog's alerts post through.
    readonly extensionId: string;
}

export interface Service {
    readonly snapshot: () => Promise<Snapshot>;
    readonly finding: (id: string) => Promise<Finding | undefined>;
    // A round now, answered when it ends.
    readonly refresh: () => Promise<void>;
    // A round soon, for a caller that does not wait.
    readonly nudge: () => void;
    readonly fix: (finding: Finding, request: FixRequest, caller: ExtensionCaller | undefined) => Promise<FixOutcome>;
    readonly resolve: (finding: Finding) => Promise<void>;
    readonly dismiss: (finding: Finding) => Promise<void>;
    readonly snooze: (finding: Finding) => Promise<void>;
    readonly wire: (connection: string, origin: string) => Promise<number>;
    readonly settled: (run: RunSettled) => Promise<void>;
    readonly start: () => void;
    readonly stop: () => void;
    readonly health: () => ExtensionHealth;
}

// What the last round found, for the backend's health on the Extensions tab.
interface RoundReport {
    readonly connections: number;
    readonly failing: readonly string[];
}

const healthOf = (round: RoundReport | undefined): ExtensionHealth => {
    if (round === undefined) {
        return { state: `starting`, detail: `reading PostHog for the first time` };
    }
    if (round.connections > 0 && round.failing.length === round.connections) {
        return { state: `degraded`, detail: `PostHog could not be read on ${round.failing.join(`, `)}: Product health says why` };
    }
    return { state: `ok` };
};

// The `Owner step:` line an attempt of this extension ended on, kept by conversation; a later turn without one clears it.
const notedOwnerStep = (state: State, run: RunSettled): State | undefined => {
    const ours = run.conversationId.startsWith(`health-`) || Object.values(state.woken).includes(run.conversationId);
    if (!ours) {
        return undefined;
    }
    const step = ownerStepOf(run.closing);
    const ownerSteps = { ...state.ownerSteps };
    if (step === undefined) {
        delete ownerSteps[run.conversationId];
    } else {
        ownerSteps[run.conversationId] = step;
    }
    return { ...state, ownerSteps };
};

// PostHog's Inbox keeps who works a report, so a second agent (PostHog's own, or another sandbox's) does not start on it
// too. A refused claim is said in the log, never in the way of the fix.
const claimReport = async (deps: ServiceDeps, client: PostHogClient, finding: Finding): Promise<void> => {
    try {
        const claim = await client.claimReport(finding.sourceId, { claimId: (await deps.state.read()).claims[finding.id] });
        if (claim !== undefined) {
            await deps.state.update((state) => ({ ...state, claims: { ...state.claims, [finding.id]: claim } }));
        }
    } catch (error) {
        deps.log(`could not claim the Inbox report behind ${finding.id}: ${errorMessage(error)}`);
    }
};

export const createService = (deps: ServiceDeps): Service => {
    let lastRound: RoundReport | undefined;
    const projects = new Map<string, string | undefined>();
    const clientFor = async (connection: string): Promise<PostHogClient> => deps.clientOf(await deps.daemon.connection(connection));

    const round = async (): Promise<void> => {
        const connections = await deps.daemon.postHogConnections();
        await forgetGone(deps.state, connections);
        const wake = { daemon: deps.daemon, state: deps.state, log: deps.log, now: deps.now, project: (connection: string) => projects.get(connection) };
        for (const connection of connections) {
            await pollConnection(
                { ...deps, transitioned: (finding, transition) => void wakeOn(wake, finding, transition) },
                connection,
            );
            projects.set(connection, (await deps.state.read()).connections[connection]?.project);
        }
        const held = await deps.state.read();
        lastRound = { connections: connections.length, failing: connections.filter((id) => held.connections[id]?.problems.some((problem) => problem.source === `connection`) === true) };
    };
    const scheduler = roundScheduler(round, TIMING, deps.now, deps.log);

    return {
        snapshot: async () => snapshotOf(await deps.state.read(), await deps.daemon.roster(), await deps.daemon.postHogConnections()),
        finding: async (id) => findingIn(await deps.state.read(), await deps.daemon.roster(), id),
        refresh: scheduler.refresh,
        nudge: scheduler.nudge,
        fix: async (finding, request, caller) => {
            const project = (await deps.state.read()).connections[finding.connection]?.project;
            const outcome = await startFindingFix(deps.daemon, finding, request, { project, now: deps.now(), caller });
            if (outcome.kind === `started` && finding.source === `report`) {
                await claimReport(deps, await clientFor(finding.connection), finding);
            }
            return outcome;
        },
        resolve: async (finding) => resolveFinding(await clientFor(finding.connection), deps.state, finding, deps.now()),
        dismiss: async (finding) => dismissFinding(await clientFor(finding.connection), deps.state, finding),
        snooze: async (finding) => {
            await snoozeFinding(await clientFor(finding.connection), deps.state, finding, deps.now());
        },
        wire: async (connection, origin) => {
            const token = (await deps.state.read()).hookToken;
            const url = `${origin.replace(/\/+$/, ``)}/door/${deps.extensionId}/hook/${token}`;
            return wireAlerts(await clientFor(connection), deps.state, connection, url, token);
        },
        settled: async (run) => {
            await deps.state.update((state) => notedOwnerStep(state, run) ?? state);
        },
        start: scheduler.start,
        stop: scheduler.stop,
        health: () => healthOf(lastRound),
    };
};
