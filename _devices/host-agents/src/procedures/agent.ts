import { type FixtureRouter, Frames, refuse } from "@intentic/contract-serve";
import { oneLine } from "@intentic/base/one-line";
import type { AttachFrame } from "@intentic/sandbox-contract/events/agent-events";
import { clipTitle, newConversationId } from "@intentic/sandbox-contract/ids/conversation-ids";
import type { Run } from "../run.js";
import { type HostFolder, type HostState, NOT_ACCEPTED, type Queued, type RunAsk } from "../state.js";
import type { StoredConversation } from "../store.js";
import { beginTurn } from "../turns.js";

// THE CONTRACT'S `agent` GROUP ON THIS COMPUTER: say something to an agent, watch its turn, answer its cards, stop it.
// Steering a running turn, rewinding, and the queue's own doors are a sandbox's: here a message sent mid-turn waits and
// goes out as the next turn, and the hello frame leaves the rest out so the chat never offers them.

// How long an attach waits for the run after one the reader watched end: a waiting message's turn starts within a moment.
const NEXT_RUN_WAIT_MS = 3_000;

const wordsOf = (ask: RunAsk): string => (ask.continues === true ? `Continue from where you stopped.` : ask.prompt);

// A conversation's record as its first message opens it, made at once: the window that sent it asks for the
// conversation in the same moment. A message that names no harness starts on the first there is, and the turn settles
// which one this place can actually run before it starts anything (turns.ts).
const opened = (state: HostState, folder: HostFolder, id: string, ask: RunAsk, prompt: string): StoredConversation => {
    const at = state.now();
    const record: StoredConversation = {
        v: 1,
        id,
        folder: folder.root,
        provider: ask.agent ?? state.harnesses[0]?.id ?? `claude`,
        status: `idle`,
        createdAt: at,
        updatedAt: at,
        turns: 0,
        toolUses: 0,
        rows: [],
    };
    const title = ask.title ?? (prompt.trim() === `` ? undefined : clipTitle(oneLine(prompt)));
    if (title !== undefined) {
        record.title = title;
    }
    return record;
};

const ended = (): Frames<AttachFrame> =>
    new Frames((sink) => {
        sink.emit({ kind: `end` });
        sink.close();
        return () => undefined;
    });

const watching = (run: Run): Frames<AttachFrame> =>
    new Frames((sink) => {
        run.attach(sink);
        return () => undefined;
    });

// The run after `after`, waited for a moment where the reader watched that one end.
const runAfter = (state: HostState, folder: HostFolder, id: string, after: string): Promise<Run | undefined> =>
    new Promise((resolve) => {
        const current = state.liveIn(folder, id)?.run;
        if (current !== undefined && current.id !== after) {
            resolve(current);
            return;
        }
        const waiters = state.nextRun.get(id) ?? new Set<() => void>();
        state.nextRun.set(id, waiters);
        const wake = (): void => {
            clearTimeout(timer);
            waiters.delete(wake);
            resolve(state.liveIn(folder, id)?.run);
        };
        const timer = setTimeout(wake, NEXT_RUN_WAIT_MS);
        waiters.add(wake);
    });

export const agentProcedures = (state: HostState, folder: HostFolder) =>
    ({
        run: async (ask) => {
            await state.loaded;
            if (!state.accepted()) {
                return refuse(NOT_ACCEPTED, 403);
            }
            const id = ask.conversationId ?? newConversationId();
            const prompt = wordsOf(ask);
            const queued: Queued = { prompt, attachments: ask.attachments ?? [], ask };
            const held = state.records.get(id);
            if (held !== undefined && held.folder !== folder.root) {
                return refuse(`That conversation works in another folder.`, 409);
            }
            const turn = state.live.get(id);
            if (turn !== undefined) {
                // Held behind the running turn, and listed on its card meanwhile so every window draws it as waiting.
                turn.queueRevision += 1;
                turn.queue.push({
                    ...queued,
                    id: ask.messageId ?? `${turn.run.id}-waiting-${turn.queueRevision}`,
                    queuedAt: state.now(),
                    revision: turn.queueRevision,
                });
                state.broadcast(folder.root);
                return { delivered: `queued` as const };
            }
            const record = held ?? opened(state, folder, id, ask, prompt);
            return { delivered: `started` as const, run: beginTurn(state, folder, record, queued).id };
        },
        attach: async ({ conversationId, after }) => {
            await state.loaded;
            // A conversation of another folder has, for this window, no run to watch.
            if (state.records.get(conversationId)?.folder !== folder.root) {
                return ended();
            }
            const run =
                after === undefined
                    ? (state.live.get(conversationId)?.run ?? state.finished.get(conversationId))
                    : await runAfter(state, folder, conversationId, after);
            return run === undefined ? ended() : watching(run);
        },
        reply: (reply) => {
            // Only a card raised in one of this folder's conversations is this window's to answer.
            for (const [id, turn] of state.live) {
                if (state.records.get(id)?.folder === folder.root && turn.run.resolve(reply)) {
                    return { ok: true as const };
                }
            }
            return refuse(`Nothing is waiting on that answer any more.`, 404);
        },
        // Named by its run, or by the message that started it; a stop for a run that has since ended cancels nothing.
        stop: (ask) => {
            const turn = state.liveIn(folder, ask.conversationId);
            if (turn === undefined || (`run` in ask && turn.run.id !== ask.run)) {
                return { stopped: false };
            }
            turn.stopping = true;
            turn.stop.abort();
            state.broadcast(folder.root);
            return { stopped: true };
        },
        commands: ({ agent }) => ({ commands: [...(state.commands.get(agent ?? ``) ?? [])] }),
        refusals: () => ({ refusals: {} }),
    }) satisfies FixtureRouter[`agent`];
