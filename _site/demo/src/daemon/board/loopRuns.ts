import type { Loop, LoopDesign, LoopRecord } from "@intentic/sandbox-contract/schemas/loops";
import { loopCanConverge } from "@intentic/sandbox-contract/schemas/loops";
import { refuse } from "@intentic/contract-serve";
import { demoLoops } from "../../fixture/loops";
import { patchAgent, roster } from "./roster";
import { putCard, workCard } from "./workCards";

// Saved loops and running ones as a store. A design saves and deletes for real; a loop started on a conversation plays
// its rounds on that conversation's card (the round count the composer's badge reads), converging on its third round,
// as the daemon refuses and answers (_sandbox/sandbox/src/loops/loops.routes.ts).

const ROUND_MS = 5_000;
const ROUNDS_TO_CONVERGE = 3;

let designs: LoopDesign[] | undefined;
const designStore = (): LoopDesign[] => (designs ??= demoLoops());

export const loopDesigns = (): LoopDesign[] => designStore();

const CANNOT_CONVERGE = `This loop has no output and no check, so nothing could ever tell it it is finished.`;

export const saveLoopDesign = (design: LoopDesign, create: boolean): LoopDesign => {
    if (!loopCanConverge(design)) {
        refuse(CANNOT_CONVERGE, 400);
    }
    const exists = designStore().some((held) => held.id === design.id);
    if (create && exists) {
        refuse(`A saved loop called "${design.name}" already exists.`, 409);
    }
    if (!create && !exists) {
        refuse(`That saved loop no longer exists, it may have been deleted in another tab.`, 404);
    }
    designs = exists ? designStore().map((held) => (held.id === design.id ? design : held)) : [...designStore(), design];
    return design;
};

export const removeLoopDesign = (id: string): void => {
    if (!designStore().some((held) => held.id === id)) {
        refuse(`No saved loop with that id.`, 404);
    }
    designs = designStore().filter((held) => held.id !== id);
};

interface Running {
    readonly record: LoopRecord;
    timer?: ReturnType<typeof setTimeout>;
}
const running = new Map<string, Running>();

const project = (record: LoopRecord): void => {
    patchAgent(record.conversationId, {
        loop: { state: record.state, iteration: record.iterations.length, maxIterations: record.maxIterations, goal: record.goal },
        status: record.state === `running` ? `running` : `idle`,
        updatedAt: Date.now(),
    });
};

// One round: it changes something, the check reads it, and the third round's check passes.
const round = (entry: Running): void => {
    const { record } = entry;
    const n = record.iterations.length + 1;
    const done = n >= Math.min(ROUNDS_TO_CONVERGE, record.maxIterations);
    const check = record.checks[0];
    const said = check?.kind === `command` ? `\`${check.command}\`` : `The reviewer`;
    record.iterations.push({
        n,
        at: Date.now(),
        outcome: done ? `done` : `continue`,
        detail: done ? `${said} passed: the goal is met.` : `${said} still fails: ${3 - n} problem${3 - n === 1 ? `` : `s`} left.`,
        costUsd: 0.18,
        changed: true,
    });
    if (done || n >= record.maxIterations) {
        record.state = done ? `done` : `exhausted`;
        record.endedAt = Date.now();
        running.delete(record.conversationId);
    } else {
        entry.timer = setTimeout(() => round(entry), ROUND_MS);
    }
    project(record);
};

export const startLoop = (loop: Loop): LoopRecord => {
    if (running.has(loop.conversationId)) {
        refuse(`This agent is already looping, stop that loop before starting another.`, 409);
    }
    if (!loopCanConverge(loop)) {
        refuse(CANNOT_CONVERGE, 400);
    }
    const now = Date.now();
    const record: LoopRecord = { ...loop, state: `running`, startedAt: now, resumed: 0, iterations: [] };
    // Naming a conversation that doesn't exist yet opens it.
    if (!roster.agents.some((agent) => agent.id === loop.conversationId)) {
        putCard(workCard({ id: loop.conversationId, title: loop.goal.slice(0, 80), now, todo: loop.prompt }));
    }
    const entry: Running = { record };
    entry.timer = setTimeout(() => round(entry), ROUND_MS);
    running.set(loop.conversationId, entry);
    project(record);
    return structuredClone(record);
};

// The round under way finishes first on a real sandbox; here none is mid-flight, so it stops at once.
export const stopLoop = (conversationId: string): void => {
    const entry = running.get(conversationId) ?? refuse(`No loop is running on this agent.`, 404);
    clearTimeout(entry.timer);
    entry.record.state = `stopped`;
    entry.record.endedAt = Date.now();
    running.delete(conversationId);
    project(entry.record);
};
