import type { AttachFrame, SandboxHandlerInput } from "@intentic/sandbox-contract";
import { Frames, refuse } from "@intentic/contract-serve";
import { featuredRun, type Run, visitorRun } from "../turn";
import { AWAITING_ID, FEATURED_ID, patchAgent } from "./roster";

// The runs a visitor can start, watch, answer and stop: one live Run per conversation, attached as the frame stream
// the real daemon answers with.

const runs = new Map<string, Run>();

/** The featured turn, created on first attach so its clock starts when the visitor actually arrives. */
const runFor = (conversationId: string): Run | undefined => {
    const existing = runs.get(conversationId);
    if (existing !== undefined) {
        return existing;
    }
    if (conversationId !== FEATURED_ID) {
        return undefined;
    }
    const run = featuredRun(conversationId, Date.now());
    runs.set(conversationId, run);
    return run;
};

export const attach = (conversationId: string): Frames<AttachFrame> => {
    const run = runFor(conversationId);
    if (run === undefined) {
        // Nothing is running on this conversation, the same empty stream a real daemon answers with.
        return new Frames((sink) => {
            sink.emit({ kind: `end` });
            sink.close();
            return () => {};
        });
    }
    return new Frames((sink) => {
        run.attach(sink);
        return () => {};
    });
};

// Prefixes for the rail's isolated extension runs (xt-/dg-/mt-), refused here; a prefixless run still works.
const EXTENSION_RUN_PREFIXES = [`xt-`, `dg-`, `mt-`];

export const startTurn = ({ conversationId = FEATURED_ID, prompt }: SandboxHandlerInput<`agent`, `run`>): { delivered: `started`; run: string } => {
    if (EXTENSION_RUN_PREFIXES.some((prefix) => conversationId.startsWith(prefix))) {
        return refuse(`This is the demo workspace: a run needs your repositories and a sandbox to walk them in. Start one and this button works.`);
    }
    runs.get(conversationId)?.stop();
    const run = visitorRun(conversationId, prompt, Date.now());
    runs.set(conversationId, run);
    // As the daemon derives them (agents-registry summaryOf): a live turn has nothing parked, and a refused land's flag
    // and causes follow the `conflict` status the turn replaces, so they go with it.
    patchAgent(conversationId, {
        status: `running`,
        startedAt: Date.now(),
        updatedAt: Date.now(),
        attention: { plan: false, question: false, permission: false, capability: false, credential: false, conflict: false },
        conflictCauses: undefined,
    });
    return { delivered: `started`, run: run.id };
};

export const reply = (answer: SandboxHandlerInput<`agent`, `reply`>): { ok: true } => {
    for (const run of runs.values()) {
        run.resolve(answer.requestId, answer);
    }
    // The card that was parked belongs to the agent whose attention flag raised it: answering clears it.
    patchAgent(AWAITING_ID, {
        attention: { plan: false, question: false, permission: false, capability: false, credential: false, conflict: false },
    });
    return { ok: true };
};

export const stopTurn = ({ conversationId }: SandboxHandlerInput<`agent`, `stop`>): { stopped: boolean } => {
    const run = runs.get(conversationId);
    run?.stop();
    patchAgent(conversationId, { status: `stopped`, updatedAt: Date.now() });
    return { stopped: run !== undefined };
};
