import type { DaemonDoors, ExtensionCaller, ExtensionServerApi } from "@intentic/extension-api";
import type { MessageReceipt } from "@intentic/sandbox-contract/schemas/agent";
import type { AgentSummary } from "@intentic/sandbox-contract/schemas/agents";
import type {
    CiFailedStep,
    CiLocalMain,
    CiMainLine,
    CiRepairHandOver,
    CiRunsResponse,
    PipelineJob,
    PipelineRun,
} from "@intentic/sandbox-contract/schemas/ci";
import { z } from "zod";

// WHAT THE BACKEND ASKS THE DAEMON (2026-11-26), each route declared in the manifest's `permissions.daemon`: the forges'
// word through the core's CI clients and their credentials (CI ingestion stays core), the conversations main's fix
// agent runs in, and the connected computers a CI runner may be on. Main's fix agent and the Pipelines board read the
// daemon through this alone, so a test stands one in.

type Rpc = ExtensionServerApi["daemon"]["rpc"];
type System = Rpc["system"];
// What POST /agent takes, as the typed client asks for it.
export type AgentRun = Parameters<Rpc["agent"]["run"]>[0];
type Answer<P extends keyof System> = System[P] extends (...args: never[]) => PromiseLike<infer A> ? A : never;
export type CiFleet = Answer<"deviceCiFleet">;
export type CiRunner = CiFleet["runners"][number];
export type Device = Answer<"devices">["devices"][number];

// What the workflow file of a run says, for its job graph (workflow-graph.ts): the file and those it calls, by key.
export interface WorkflowFiles {
    readonly root?: string | undefined;
    readonly called: Readonly<Record<string, string>>;
}

export interface PipelinesDaemon {
    // The forges' word, through the core's clients.
    readonly mainLines: () => Promise<readonly CiMainLine[]>;
    readonly runs: () => Promise<CiRunsResponse>;
    readonly listRuns: (repo: string, limit: number) => Promise<readonly PipelineRun[]>;
    readonly run: (repo: string, runId: number) => Promise<PipelineRun>;
    readonly failedSteps: (repo: string, runId: number) => Promise<readonly CiFailedStep[]>;
    readonly passedJobs: (repo: string, runId: number) => Promise<readonly string[]>;
    readonly allJobs: (repo: string, runId: number) => Promise<readonly PipelineJob[]>;
    readonly workflow: (repo: string, runId: number) => Promise<WorkflowFiles>;
    readonly jobLog: (repo: string, jobId: number) => Promise<string>;
    readonly annotations: (repo: string, jobId: number) => Promise<readonly string[]>;
    readonly rerunFailed: (repo: string, runId: number) => Promise<void>;
    readonly localMain: () => Promise<{ readonly local: readonly CiLocalMain[]; readonly text: string }>;
    // Main lines' failures taken (or let go of) for this extension's fix agent, and main's repair handed over once.
    readonly claimMainLines: (claimed: boolean) => Promise<void>;
    readonly handOverRepair: () => Promise<CiRepairHandOver>;
    // The conversations: one by id (undefined once it is gone), the live roster and the archive's ids.
    readonly agent: (id: string) => Promise<AgentSummary | undefined>;
    readonly roster: () => Promise<readonly AgentSummary[]>;
    readonly archivedIds: () => Promise<readonly string[]>;
    // Words into a conversation (POST /agent): a turn started, said into the running one, or queued. As the extension, or
    // as the person a caller assertion names, who then owns the conversation it opens.
    readonly say: (turn: AgentRun, as?: ExtensionCaller) => Promise<MessageReceipt>;
    readonly stop: (conversationId: string) => Promise<void>;
    // Files a conversation away; answers why it would not.
    readonly archive: (conversationId: string) => Promise<string | undefined>;
    // The connected computers, and the CI runners one has.
    readonly devices: () => Promise<readonly Device[]>;
    readonly ciFleet: (device: string) => Promise<CiFleet>;
}

// A refusal the daemon answered with carries its HTTP status; one that never got an answer carries none.
const AnsweredSchema = z.object({ status: z.number() });

export const daemonOf = (doors: ExtensionServerApi["daemon"]): PipelinesDaemon => {
    const { rpc } = doors;
    const on = (as: ExtensionCaller | undefined): DaemonDoors => (as === undefined ? doors : doors.asCaller(as));
    return {
        mainLines: async () => (await rpc.ci.mainLines()).lines,
        runs: () => rpc.ci.runs(),
        listRuns: async (repo, limit) => (await rpc.ci.list({ repo, limit })).runs,
        run: async (repo, runId) => (await rpc.ci.run({ repo, runId })).run,
        failedSteps: async (repo, runId) => (await rpc.ci.failedSteps({ repo, runId })).steps,
        passedJobs: async (repo, runId) => (await rpc.ci.passedJobs({ repo, runId })).jobs,
        allJobs: async (repo, runId) => (await rpc.ci.jobs({ repo, runId })).jobs,
        workflow: (repo, runId) => rpc.ci.workflow({ repo, runId }),
        jobLog: async (repo, jobId) => (await rpc.ci.jobLog({ repo, jobId })).log,
        annotations: async (repo, jobId) => (await rpc.ci.jobAnnotations({ repo, jobId })).annotations,
        rerunFailed: async (repo, runId) => {
            await rpc.ci.rerunFailed({ repo, runId });
        },
        localMain: () => rpc.ci.localMain(),
        claimMainLines: async (claimed) => {
            await rpc.ci.claimMainLines({ claimed });
        },
        handOverRepair: () => rpc.ci.handOverRepair(),
        agent: async (id) => {
            try {
                return await rpc.agents.get({ id });
            } catch (error) {
                if (AnsweredSchema.safeParse(error).data?.status === 404) {
                    return undefined;
                }
                throw error;
            }
        },
        roster: async () => (await rpc.agents.list()).agents,
        archivedIds: async () => (await rpc.agents.archived()).agents.map((agent) => agent.id),
        say: (turn, as) => on(as).rpc.agent.run(turn),
        stop: async (conversationId) => {
            await rpc.agent.stop({ conversationId, live: true });
        },
        archive: async (conversationId) => (await rpc.agents.archive({ ids: [conversationId] })).failed[0]?.reason,
        devices: async () => (await rpc.system.devices()).devices,
        ciFleet: (device) => rpc.system.deviceCiFleet({ id: device }),
    };
};
