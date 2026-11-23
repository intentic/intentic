import type { agentsContract } from "@intentic/sandbox-contract/contracts/agents.contract";
import type { AgentSummary } from "@intentic/sandbox-contract/schemas/agents";
import type { Implementer } from "@orpc/server";
import type { OrpcContext } from "../app-env.js";
import type { Services } from "../composition.js";
import { cancelWatcher, cancelWatchersFor } from "../agent/verification/watchers.js";
import { backgroundJobOf } from "../agent/tools/jobs/background-jobs.js";
import { stopJob } from "../agent/tools/jobs/job-fates.js";
import { stopFamily, stopOneRun } from "../agent/subagents/family/family-stop.js";
import type { agentLookups } from "./agent-lookups.js";
import { type RunnerStopped, stopOnRunner } from "../runners/live/runner-stops.js";

type AgentsImplementer = Implementer<typeof agentsContract, OrpcContext, OrpcContext>;
type Lookups = Pick<ReturnType<typeof agentLookups>, "entryFor" | "workEntryFor" | "framed"> & {
    // The card as a press left it (agents.routes.ts).
    readonly summaryAfter: (services: Pick<Services, "agents">, id: string) => AgentSummary;
};

// A PERSON'S STOPS ON A CARD, for what a conversation keeps going beside its turn: the watches that would wake it, the
// background jobs it left running, and everything it and the agents below it started (family-stop.ts). Each is legal in
// every state, mid-turn included. Each answers the card and whether anything stopped (2026-11-23): a press that stopped
// nothing (the job had already ended, the watch had fired, the runner is out of reach) says so with the reason rather than
// passing for a stop, and is never an error, so a caller stopping several things goes on to the next. A conversation
// that runs on a runner keeps its jobs and watches there, and the stop is carried to it (runners/live/runner-stops.ts);
// what this sandbox stopped for the same press stands whatever the runner says.

// This daemon's own job of the conversation, stopped; false when there was none still running.
export const stopOwnJob = async (services: Pick<Services, "conversations" | "logger">, conversationId: string, jobId: string): Promise<boolean> => {
    const job = backgroundJobOf(services.conversations, conversationId, jobId);
    return job !== undefined && (await stopJob({ conversations: services.conversations, logger: services.logger }, job, "person"));
};

// This daemon's own watches of the conversation, one or all, disarmed; false when none was armed. Awaited: the disarm must
// reach the watch journal, or a recreate would restore it on boot.
export const stopOwnWatches = async (conversationId: string, watchId: string | undefined): Promise<boolean> =>
    watchId === undefined ? (await cancelWatchersFor(conversationId)) > 0 : await cancelWatcher(conversationId, watchId);

// The answer to a press: stopped when either side stopped something; else the runner's reason, or `none`.
export const stopAnswer = (own: boolean, remote: RunnerStopped, none: string): { stopped: boolean; stopReason?: string } =>
    own || remote.stopped ? { stopped: true } : { stopped: false, stopReason: remote.reason ?? none };

export const cardStopRoutes = (i: AgentsImplementer, services: Services, { entryFor, workEntryFor, framed, summaryAfter }: Lookups) => ({
    // The only user-initiated way to end a watch; every other exit is automatic (it fires, times out, or a later
    // turn stops it). A watch is a timer, not turn state.
    stopWatching: i.stopWatching.handler(async ({ input, context }) => {
        const entry = entryFor(input.id, context);
        const own = await stopOwnWatches(entry.id, input.watchId);
        const remote = await stopOnRunner(services, entry, { kind: "watch", watchId: input.watchId });
        const none = input.watchId === undefined ? "this conversation has no armed watch" : "that watch has already fired or was stopped";
        // Reads back through `get`, not the live roster: an archived conversation can still hold armed watches.
        return { ...framed(context, summaryAfter(services, entry.id)), ...stopAnswer(own, remote, none) };
    }),
    // The server it handed over, the build it waits on; the job's watch is disarmed before it ends, so nothing wakes.
    stopJob: i.stopJob.handler(async ({ input, context }) => {
        const entry = entryFor(input.id, context);
        const own = await stopOwnJob(services, entry.id, input.jobId);
        const remote = own ? { stopped: false } : await stopOnRunner(services, entry, { kind: "job", jobId: input.jobId });
        return { ...framed(context, summaryAfter(services, entry.id)), ...stopAnswer(own, remote, "that job has already ended") };
    }),
    // Stop all: its turn, its workflow runs and everything below it, or, naming a run, that run and its workers alone.
    // Driving the conversation is what it takes, as its own Stop does.
    stopFamily: i.stopFamily.handler(async ({ input, context }) => {
        const entry = workEntryFor(input.id, context, "drive");
        return input.run === undefined ? stopFamily(services, entry.id) : stopOneRun(entry.id, input.run);
    }),
});
