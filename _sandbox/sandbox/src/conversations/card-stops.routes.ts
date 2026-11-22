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

type AgentsImplementer = Implementer<typeof agentsContract, OrpcContext, OrpcContext>;
type Lookups = Pick<ReturnType<typeof agentLookups>, "entryFor" | "workEntryFor" | "framed"> & {
    // The card as a press left it (agents.routes.ts).
    readonly summaryAfter: (services: Pick<Services, "agents">, id: string) => AgentSummary;
};

// A PERSON'S STOPS ON A CARD, for what a conversation keeps going beside its turn: the watches that would wake it, the
// background jobs it left running, and everything it and the agents below it started (family-stop.ts). Each is legal in
// every state, mid-turn included, and stopping what already ended is not an error: the press is satisfied either way.
export const cardStopRoutes = (i: AgentsImplementer, services: Services, { entryFor, workEntryFor, framed, summaryAfter }: Lookups) => ({
    // The only user-initiated way to end a watch; every other exit is automatic (it fires, times out, or a later
    // turn stops it). A watch is a timer, not turn state.
    stopWatching: i.stopWatching.handler(async ({ input, context }) => {
        const entry = entryFor(input.id, context);
        // Awaited: the disarm must reach the watch journal, or a recreate would restore it on boot. A named watch
        // is disarmed alone; an unknown name is already-gone, not an error, since it may have fired mid-press.
        await (input.watchId === undefined ? cancelWatchersFor(entry.id) : cancelWatcher(entry.id, input.watchId));
        // Reads back through `get`, not the live roster: an archived conversation can still hold armed watches.
        return framed(context, summaryAfter(services, entry.id));
    }),
    // The server it handed over, the build it waits on; the job's watch is disarmed before it ends, so nothing wakes.
    stopJob: i.stopJob.handler(async ({ input, context }) => {
        const entry = entryFor(input.id, context);
        const job = backgroundJobOf(services.conversations, entry.id, input.jobId);
        // An unknown id is a job already gone (it exited, or a restart forgot it).
        if (job !== undefined) {
            await stopJob({ conversations: services.conversations, logger: services.logger }, job, "person");
        }
        return framed(context, summaryAfter(services, entry.id));
    }),
    // Stop all: its turn, its workflow runs and everything below it, or, naming a run, that run and its workers alone.
    // Driving the conversation is what it takes, as its own Stop does.
    stopFamily: i.stopFamily.handler(async ({ input, context }) => {
        const entry = workEntryFor(input.id, context, "drive");
        return input.run === undefined ? stopFamily(services, entry.id) : stopOneRun(entry.id, input.run);
    }),
});
