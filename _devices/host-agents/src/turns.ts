import { errorMessage } from "@intentic/base/errors";
import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import { userRow } from "@intentic/sandbox-contract/transcript-fold";
import type { HarnessConnection } from "./connection.js";
import { harnessState } from "./engines.js";
import { createRun, type Run } from "./run.js";
import type { HostFolder, HostState, Live, Queued } from "./state.js";
import type { StoredConversation } from "./store.js";
import { runTurn, type TurnOutcome } from "./turn.js";

// A TURN'S LIFE IN ITS CONVERSATION: started with the reader's words, driven over its harness (turn.ts), followed for
// what its card says meanwhile, and settled into the record when it ends. One turn at a time per conversation; what
// the reader says while it runs waits and goes out as the next turn.

// What a turn's frame changes on its record, if anything.
const recordChange = (held: StoredConversation, event: AgentEvent): Partial<StoredConversation> | undefined => {
    if (event.kind === `tool_call`) {
        return { toolUses: held.toolUses + 1 };
    }
    if (event.kind === `context_usage`) {
        return { contextTokens: event.tokens, contextWindow: event.contextWindow };
    }
    if (event.kind === `usage`) {
        return { inputTokens: (held.inputTokens ?? 0) + (event.inputTokens ?? 0), outputTokens: (held.outputTokens ?? 0) + (event.outputTokens ?? 0) };
    }
    return undefined;
};

// A turn's frames as its card reads them: how many tools ran, how full the context is, and what it waits on, which is
// said to the board at once since "needs you" is what a reader elsewhere is watching for.
const follow = (state: HostState, id: string, turn: Live, event: AgentEvent): void => {
    const held = state.records.get(id);
    if (held === undefined) {
        return;
    }
    const change = recordChange(held, event);
    if (change !== undefined) {
        state.records.set(id, { ...held, ...change });
    }
    if (event.kind === `commands`) {
        state.commands.set(held.provider, event.items);
    } else if (event.kind === `error`) {
        turn.failure = event.message;
    } else if (event.kind === `permission` || event.kind === `question`) {
        turn.cards.set(event.requestId, event.kind);
    } else if (event.kind === `resolved`) {
        turn.cards.delete(event.requestId);
    }
    const parked = new Set(turn.cards.values());
    const waiting = { permission: parked.has(`permission`), question: parked.has(`question`) };
    if (waiting.permission !== turn.waiting.permission || waiting.question !== turn.waiting.question) {
        turn.waiting = waiting;
        state.broadcast(held.folder);
    }
};

const failed = (run: Run, sessionId: string | undefined, message: string, own: boolean): TurnOutcome => {
    run.publish(own ? { kind: `error`, own: true, message } : { kind: `error`, message });
    return { sessionId, ending: `failed` };
};

// The record of a conversation whose first message named no harness, pointed at the first one this place can run now.
// The record is opened before this is known (a window asks for the conversation the moment it has sent), so it starts
// on the first harness there is and is settled here, before anything is started.
const harnessSettled = async (state: HostState, folder: HostFolder, record: StoredConversation, queued: Queued): Promise<StoredConversation> => {
    if (queued.ask.agent !== undefined || record.turns > 0) {
        return record;
    }
    const host = state.hostFor(folder.place);
    const ready = await Promise.all(state.harnesses.map(async (harness) => ((await harnessState(host, harness)).state === `ready` ? harness.id : undefined)));
    const first = ready.find((found) => found !== undefined);
    const held = state.records.get(record.id) ?? record;
    return first === undefined || first === held.provider ? held : state.amend(held, { provider: first });
};

const drive = async (state: HostState, folder: HostFolder, id: string, turn: Live, queued: Queued): Promise<TurnOutcome> => {
    const opened = state.records.get(id);
    const record = opened === undefined ? undefined : await harnessSettled(state, folder, opened, queued);
    const harness = record === undefined ? undefined : state.harnessNamed(record.provider);
    if (record === undefined || harness === undefined) {
        return failed(turn.run, record?.sessionId, `This conversation's agent isn't one this computer can run.`, true);
    }
    const host = state.hostFor(folder.place);
    const cwd = state.cwdOf(folder);
    const launch = await harnessState(host, harness);
    if (launch.state !== `ready`) {
        const why = launch.state === `missing` ? launch.why : `${harness.label} isn't set up on this computer yet.`;
        turn.run.publish({ kind: `error`, own: true, code: `acp-auth-required`, message: why });
        return { sessionId: record.sessionId, ending: `failed`, signIn: true };
    }
    let connection: HarnessConnection;
    try {
        connection = await state.connections.acquire(state.keyOf(host, harness), host, launch.launch, cwd);
    } catch (error) {
        return failed(turn.run, record.sessionId, errorMessage(error), false);
    }
    let minted = 0;
    const followed: Run = {
        ...turn.run,
        publish: (event) => {
            follow(state, id, turn, event);
            turn.run.publish(event);
        },
    };
    return runTurn(
        connection,
        {
            conversationId: id,
            prompt: queued.prompt,
            attachments: queued.attachments.map((path) => host.join(cwd, path)),
            sessionId: record.sessionId,
            cwd,
            platform: host.platform,
            model: queued.ask.model,
            effort: queued.ask.effort,
            permissionMode: queued.ask.permissionMode,
            signal: turn.stop.signal,
            onSession: (sessionId) => {
                const held = state.records.get(id);
                if (held !== undefined && held.sessionId !== sessionId) {
                    state.keep({ ...held, sessionId });
                }
            },
            mintId: () => {
                minted += 1;
                return `${turn.run.id}-ask-${minted}`;
            },
        },
        followed,
    );
};

// The record a finished turn leaves: its rows added, its ending as the card's standing.
const settledRecord = (held: StoredConversation, turn: Live, outcome: TurnOutcome, at: number): StoredConversation => {
    const next: StoredConversation = {
        ...held,
        rows: [...held.rows, ...structuredClone(turn.run.rows())],
        status: outcome.ending === `settled` ? `idle` : outcome.ending === `stopped` ? `stopped` : `error`,
        turns: held.turns + 1,
        updatedAt: at,
    };
    if (outcome.sessionId !== undefined) {
        next.sessionId = outcome.sessionId;
    }
    if (outcome.ending === `failed` && turn.failure !== undefined) {
        next.failure = turn.failure;
    } else {
        delete next.failure;
    }
    return next;
};

const settle = (state: HostState, folder: HostFolder, id: string, turn: Live, outcome: TurnOutcome): void => {
    // A turn the process cut on its way out was written then (state.ts `interruptAll`): its late ending settles nothing.
    if (state.live.get(id) !== turn) {
        return;
    }
    turn.run.finish(outcome.ending === `stopped` ? `stopped` : `settled`);
    state.live.delete(id);
    state.finished.set(id, turn.run);
    state.tellRunning();
    const held = state.records.get(id);
    if (held === undefined) {
        return;
    }
    const next = settledRecord(held, turn, outcome, state.now());
    state.keep(next);
    const harness = state.harnessNamed(next.provider);
    if (harness !== undefined && outcome.ending !== `stopped`) {
        // The harness refused for want of a sign-in, whatever it says of its account: that stands until a sign-in lands
        // or a turn runs. What was known of its sign-in is asked again either way.
        const key = state.keyOf(state.hostFor(folder.place), harness);
        state.noteSignIn(key, outcome.signIn === true);
        if (outcome.signIn === true) {
            state.forgetFacts(key);
        }
    }
    state.broadcast(next.folder);
    // What was said while it ran goes out now, as one turn, however this one ended: after a failure the next turn may
    // well meet the same one, but the reader's words are then in the conversation, where they can see them, rather than
    // gone with the turn they were said behind.
    const waiting = turn.queue.splice(0);
    const last = waiting.at(-1);
    if (last !== undefined) {
        // The turn they start says their queue empty, one revision on: what takes the waiting rows off every window.
        beginTurn(
            state,
            folder,
            next,
            { prompt: waiting.map((queued) => queued.prompt).join(`\n\n`), attachments: waiting.flatMap((queued) => queued.attachments), ask: last.ask },
            turn.queueRevision + 1,
        );
    }
};

// The record as the turn's own request re-points it: the harness, model and effort the reader picked for this message.
const repointed = (record: StoredConversation, queued: Queued, at: number): StoredConversation => {
    const next: StoredConversation = { ...record, status: `idle`, updatedAt: at };
    delete next.failure;
    if (queued.ask.agent !== undefined && queued.ask.agent !== record.provider) {
        next.provider = queued.ask.agent;
        // A session belongs to the harness that opened it.
        delete next.sessionId;
    }
    if (queued.ask.model !== undefined) {
        next.model = queued.ask.model;
    }
    if (queued.ask.effort !== undefined) {
        next.effort = queued.ask.effort;
    }
    return next;
};

/** Starts a turn in `record`'s conversation and answers its run at once; the turn itself runs on from here. */
export const beginTurn = (state: HostState, folder: HostFolder, record: StoredConversation, queued: Queued, queueRevision = 0): Run => {
    const at = state.now();
    const run = createRun(`run-${record.id}-${at.toString(36)}`, record.id, [userRow(queued.prompt, at, queued.attachments, queued.ask.messageId)], state.now);
    const turn: Live = {
        run,
        stop: new AbortController(),
        cards: new Map(),
        queue: [],
        queueRevision,
        waiting: { permission: false, question: false },
        stopping: false,
        failure: undefined,
    };
    state.live.set(record.id, turn);
    state.keep(repointed(record, queued, at));
    state.broadcast(record.folder);
    state.tellRunning();
    for (const wake of state.nextRun.get(record.id) ?? []) {
        wake();
    }
    void drive(state, folder, record.id, turn, queued).then(
        (outcome) => settle(state, folder, record.id, turn, outcome),
        (error: Error) => settle(state, folder, record.id, turn, failed(run, state.records.get(record.id)?.sessionId, errorMessage(error), false)),
    );
    return run;
};
