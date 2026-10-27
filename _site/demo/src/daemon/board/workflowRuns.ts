import type { Workflow, WorkflowRun, WorkflowStepRun, WorkflowSummary } from "@intentic/sandbox-contract/schemas/workflows";
import { refuse } from "@intentic/contract-serve";
import { demoRuns, demoWorkflows } from "../../fixture/workflows";
import { patchAgent, roster } from "./roster";
import { finishCard, putCard, workCard } from "./workCards";

// The workflow designs and their runs as a store: saving and deleting a design is real, a run started here plays its
// steps in the design's order (each waits on what it needs, chained steps share one conversation) with a card on the
// board for every conversation it opens, and stopping, archiving and restoring a run change what the next read says.

// How long one step takes here, so a four-step run is watched end to end in well under a minute.
const STEP_MS = 10_000;

let designs: Workflow[] | undefined;
const designStore = (): Workflow[] =>
    (designs ??= demoWorkflows([]).map(({ runs: _runs, gateToken: _token, ...design }) => design));
const gateTokens = new Map<string, string>();

interface Played {
    readonly run: WorkflowRun;
    // When each step starts and ends, worked out once from what it waits on.
    readonly window: ReadonlyMap<string, { readonly start: number; readonly end: number }>;
    readonly timers: ReturnType<typeof setTimeout>[];
    stoppedAt?: number;
}
const played: Played[] = [];
// What the seeded run (fixture/workflows.ts, recomputed against the clock on every read) has had done to it.
const seededStoppedAt = new Map<string, number>();
const archivedAt = new Map<string, number>();

const hex = (length: number): string => [...crypto.getRandomValues(new Uint8Array(length))].map((byte) => (byte % 16).toString(16)).join(``);

// A chained step carries on its single predecessor's conversation; every other step opens its own.
const conversationsOf = (runId: string, workflow: Workflow): Map<string, string> => {
    const conversations = new Map<string, string>();
    for (const step of workflow.steps) {
        const before = step.needs.length === 1 && step.handoff === `continue` ? conversations.get(step.needs[0] ?? ``) : undefined;
        conversations.set(step.id, before ?? `wf-${runId}-${step.id}`);
    }
    return conversations;
};

// Each step starts once everything it needs has ended, the first ones at once.
const windowsOf = (workflow: Workflow, startedAt: number): Map<string, { start: number; end: number }> => {
    const windows = new Map<string, { start: number; end: number }>();
    for (const step of workflow.steps) {
        const start = Math.max(startedAt, ...step.needs.map((need) => windows.get(need)?.end ?? startedAt));
        windows.set(step.id, { start, end: start + STEP_MS });
    }
    return windows;
};

const stepAt = (step: WorkflowStepRun, window: { start: number; end: number }, now: number, stoppedAt: number | undefined): WorkflowStepRun => {
    const until = Math.min(now, stoppedAt ?? now);
    if (until < window.start) {
        return { ...step, state: stoppedAt === undefined ? `pending` : `skipped` };
    }
    if (until < window.end) {
        const rounds = 1 + Math.floor((until - window.start) / (STEP_MS / 3));
        const live: WorkflowStepRun = { ...step, state: stoppedAt === undefined ? `running` : `stopped`, startedAt: window.start, iterations: rounds, costUsd: rounds * 0.07 };
        if (stoppedAt !== undefined) {
            live.endedAt = stoppedAt;
        }
        return live;
    }
    return {
        ...step,
        state: `done`,
        startedAt: window.start,
        endedAt: window.end,
        iterations: 3,
        costUsd: 0.21,
        loopState: `done`,
        document: { done: true, reason: `The step's goal is met and its checks pass.` },
        report: `Done: the goal is met, and the work is on the step's branch for the next one.`,
    };
};

const runAt = (entry: Played, now: number): WorkflowRun => {
    const steps = entry.run.steps.map((step) => stepAt(step, entry.window.get(step.stepId) ?? { start: 0, end: 0 }, now, entry.stoppedAt));
    const ends = [...entry.window.values()].map((window) => window.end);
    const finished = steps.every((step) => step.state === `done`);
    const run: WorkflowRun = { ...entry.run, steps, state: entry.stoppedAt !== undefined ? `stopped` : finished ? `done` : `running` };
    if (entry.stoppedAt !== undefined || finished) {
        run.endedAt = entry.stoppedAt ?? Math.max(...ends);
    }
    return run;
};

// The seeded run's reviewers must be on this board's roster while they run (a board missing one hides the run), and a
// stop the visitor pressed holds on it.
const seededRuns = (now: number): WorkflowRun[] =>
    demoRuns(now)
        .filter((run) => run.steps.every((step) => step.state !== `running` || roster.agents.some((agent) => agent.id === step.conversationId)))
        .map((run) => {
            const stopped = seededStoppedAt.get(run.runId);
            return stopped === undefined
                ? run
                : { ...run, state: `stopped`, endedAt: stopped, steps: run.steps.map((step) => (step.state === `running` ? { ...step, state: `stopped`, endedAt: stopped } : step)) };
        });

/** Every run, newest first, each with its archive mark. */
export const allRuns = (now: number): WorkflowRun[] =>
    [...played.map((entry) => runAt(entry, now)).toReversed(), ...seededRuns(now)].map((run) => {
        const archived = archivedAt.get(run.runId);
        return archived === undefined ? run : { ...run, archivedAt: archived };
    });

const withToken = <T extends Workflow>(workflow: T): T & { gateToken?: string } => {
    const token = gateTokens.get(workflow.id);
    return token === undefined ? workflow : { ...workflow, gateToken: token };
};

export const workflowList = (now: number): WorkflowSummary[] => {
    const runs = allRuns(now);
    return designStore().map((design) => ({ ...withToken(design), runs: runs.filter((run) => run.workflow.id === design.id) }));
};

const designOf = (id: string): Workflow => designStore().find((design) => design.id === id) ?? refuse(`No workflow ${id}.`, 404);

/** Create and replace are distinct: a create on a taken id conflicts, a replace of a missing one is not found. */
export const saveWorkflow = (workflow: Workflow, create: boolean): Workflow & { gateToken?: string } => {
    const exists = designStore().some((design) => design.id === workflow.id);
    if (create && exists) {
        refuse(`A workflow called ${workflow.id} already exists.`, 409);
    }
    if (!create && !exists) {
        refuse(`No workflow ${workflow.id}.`, 404);
    }
    designs = exists ? designStore().map((design) => (design.id === workflow.id ? workflow : design)) : [...designStore(), workflow];
    if (workflow.gate !== undefined && !gateTokens.has(workflow.id)) {
        gateTokens.set(workflow.id, `wfg_${hex(28)}`);
    }
    return withToken(workflow);
};

// Its runs stay readable: a run copied its design when it started.
export const removeWorkflow = (id: string): void => {
    designOf(id);
    designs = designStore().filter((design) => design.id !== id);
    gateTokens.delete(id);
};

export const rotateGateToken = (id: string) => {
    if (designOf(id).gate === undefined) {
        refuse(`${id} declares no gate, so there is no token to rotate.`, 409);
    }
    const token = `wfg_${hex(28)}`;
    gateTokens.set(id, token);
    return { token };
};

// Opens a step's conversation on the board when it starts, and ends its turn when it ends.
const scheduleCards = (entry: Played, workflow: Workflow, conversations: Map<string, string>, now: number): void => {
    workflow.steps.forEach((step, index) => {
        const window = entry.window.get(step.id);
        const id = conversations.get(step.id);
        if (window === undefined || id === undefined) {
            return;
        }
        const projection = { runId: entry.run.runId, name: workflow.name, step: step.title ?? step.id, index: index + 1, total: workflow.steps.length };
        const open = (): void => {
            if (roster.agents.some((agent) => agent.id === id)) {
                patchAgent(id, { status: `running`, updatedAt: Date.now(), workflow: projection });
                return;
            }
            putCard(workCard({ id, title: step.title ?? step.goal, now: Date.now(), todo: step.goal, extra: { workflow: projection } }));
        };
        if (window.start <= now) {
            open();
        } else {
            entry.timers.push(setTimeout(open, window.start - now));
        }
        entry.timers.push(setTimeout(() => finishCard(id, Date.now(), 0.21), window.end - now));
    });
};

/** Starts a run of a saved design: every step is written down as waiting, the first ones start at once. */
export const startWorkflowRun = (id: string, request: string | undefined): WorkflowRun => {
    const workflow = designOf(id);
    const now = Date.now();
    const runId = hex(8);
    const conversations = conversationsOf(runId, workflow);
    const run: WorkflowRun = {
        runId,
        workflow,
        repos: [{ repo: `root`, base: hex(40) }],
        state: `running`,
        startedAt: now,
        resumed: 0,
        steps: workflow.steps.map((step) => ({ stepId: step.id, state: `pending`, conversationId: conversations.get(step.id) ?? ``, iterations: 0 })),
    };
    if (request !== undefined) {
        run.request = request;
    }
    const entry: Played = { run, window: windowsOf(workflow, now), timers: [] };
    played.push(entry);
    scheduleCards(entry, workflow, conversations, now);
    return runAt(entry, now);
};

/** Stops a running run: its running steps stop, what was still waiting never runs. */
export const stopWorkflowRun = (runId: string): void => {
    const now = Date.now();
    const entry = played.find((candidate) => candidate.run.runId === runId);
    if (entry !== undefined) {
        entry.stoppedAt = now;
        for (const timer of entry.timers) {
            clearTimeout(timer);
        }
        for (const step of runAt(entry, now).steps) {
            if (step.state === `stopped`) {
                patchAgent(step.conversationId, { status: `stopped`, updatedAt: now });
            }
        }
        return;
    }
    const seeded = demoRuns(now).find((run) => run.runId === runId) ?? refuse(`No workflow run ${runId}.`, 404);
    seededStoppedAt.set(runId, now);
    for (const step of seeded.steps.filter((candidate) => candidate.state === `running`)) {
        patchAgent(step.conversationId, { status: `stopped`, updatedAt: now });
    }
};

const knownRun = (runId: string): void => {
    if (!allRuns(Date.now()).some((run) => run.runId === runId)) {
        refuse(`No workflow run ${runId}.`, 404);
    }
};

export const archiveWorkflowRun = (runId: string): void => {
    knownRun(runId);
    archivedAt.set(runId, Date.now());
};

export const unarchiveWorkflowRun = (runId: string): void => {
    knownRun(runId);
    archivedAt.delete(runId);
};
