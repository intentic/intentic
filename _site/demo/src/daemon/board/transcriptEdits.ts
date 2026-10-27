import { type TranscriptTool, TranscriptToolSchema } from "@intentic/sandbox-contract/events/transcript";
import type { SandboxHandlerInput, SandboxHandlerOutput } from "@intentic/sandbox-contract/protocol/procedure-types";
import { homeConversationId, isHomeConversationId } from "@intentic/sandbox-contract/ids/conversation-ids";
import { refuse } from "@intentic/contract-serve";
import type { HomeSandbox } from "../../fixture/home/sandboxes";
import { transcriptFor } from "../../fixture/transcripts";
import { DEMO_USER } from "../../platform";
import { refuseWhileRunning } from "./review";
import { patchAgent, roster } from "./roster";

// What a person did to a conversation's record this page load, laid over the recorded transcript (fixture/transcripts.ts)
// the way the daemon's own record changes under the same presses: a line placed in the agent's mouth, a rewind that drops
// every message after a point, a home conversation's history cleared. Every later read of the record says so.

type Transcript = SandboxHandlerOutput<`agents`, `transcript`>;
type TranscriptRow = Transcript[`messages`][number];

interface RecordEdits {
    // How many of the recorded messages survive, once a rewind or a clear has cut the record.
    kept?: number;
    // Lines placed since, in order, after whatever survives.
    placed: TranscriptRow[];
}

const edits = new Map<string, RecordEdits>();

// A home conversation has the same id in every sandbox (it is named after its person), so its record is the one sandbox's.
const recordKey = (id: string, sandbox: HomeSandbox): string => (isHomeConversationId(id) ? `${sandbox}/${id}` : id);
const editsOf = (id: string, sandbox: HomeSandbox): RecordEdits => {
    const key = recordKey(id, sandbox);
    const held = edits.get(key) ?? { placed: [] };
    edits.set(key, held);
    return held;
};

// Every message a person sent can be gone back to, as the daemon's rewind points offer it: named by its own id and its
// position in the record. Recorded rows without an id get one minted from their place, which is how the daemon names
// rows recorded before ids (`@12`).
const withRewindPoints = (id: string, messages: readonly TranscriptRow[]): TranscriptRow[] =>
    messages.map((row, index) => {
        if (row.role !== `user`) {
            return row;
        }
        const messageId = row.messageId ?? `msg_${id}_${index}`;
        return { ...row, messageId, rewindIndex: index, checkpointId: row.checkpointId ?? `chk_${id}_${index}` };
    });

const recorded = (id: string, sandbox: HomeSandbox): TranscriptRow[] => withRewindPoints(id, transcriptFor(id, sandbox).messages);

/** The record as this page load left it: cut where a rewind or a clear cut it, with the placed lines after it. */
export const editedTranscript = (id: string, sandbox: HomeSandbox): Transcript => {
    const base = transcriptFor(id, sandbox);
    const held = edits.get(recordKey(id, sandbox));
    const messages = recorded(id, sandbox);
    const kept = held?.kept === undefined ? messages : messages.slice(0, held.kept);
    return { ...base, messages: [...kept, ...(held?.placed ?? [])], from: 0, more: false };
};

export const placeLine = ({ id, text }: SandboxHandlerInput<`agents`, `place`>, sandbox: HomeSandbox): SandboxHandlerOutput<`agents`, `place`> => {
    refuseWhileRunning(id);
    const rowId = `row_placed_${crypto.randomUUID().slice(0, 8)}`;
    editsOf(id, sandbox).placed.push({ role: `assistant`, text, rowId, openedAt: Date.now(), placed: true });
    // The next turn starts fresh from the record, as a rewind does: the provider session is let go.
    patchAgent(id, { sessionId: undefined, updatedAt: Date.now() });
    return { ok: true, rowId };
};

// Refused as the daemon refuses: mid-turn (409), a message with no saved state (404), and a position that no longer holds
// the message named (412).
export const rewindRecord = ({ conversationId, index, messageId }: SandboxHandlerInput<`agent`, `rewind`>, sandbox: HomeSandbox): SandboxHandlerOutput<`agent`, `rewind`> => {
    refuseWhileRunning(conversationId);
    const current = editedTranscript(conversationId, sandbox).messages;
    const at = current[index];
    if (at === undefined || at.checkpointId === undefined) {
        return refuse(`That message has no saved point to go back to.`, 404);
    }
    if (at.messageId !== messageId) {
        return refuse(`The conversation has moved on since you read it.`, 412);
    }
    const held = editsOf(conversationId, sandbox);
    const recordedCount = recorded(conversationId, sandbox).length;
    // A cut inside the placed lines keeps the record whole and drops only the placed lines after it.
    if (index >= (held.kept ?? recordedCount)) {
        held.placed = held.placed.slice(0, index - (held.kept ?? recordedCount));
    } else {
        held.kept = index;
        held.placed = [];
    }
    patchAgent(conversationId, { sessionId: undefined, updatedAt: Date.now() });
    const card = roster.agents.find((agent) => agent.id === conversationId);
    const answer: SandboxHandlerOutput<`agent`, `rewind`> = { dropped: current.length - index };
    // A conversation in its own copy moved a branch back; one in the shared tree put the saved point's files back.
    if (card?.branch === undefined) {
        answer.snapshot = at.checkpointId;
    }
    return answer;
};

const homeOf = (sandbox: HomeSandbox) => {
    const id = homeConversationId(DEMO_USER.email);
    refuseWhileRunning(id);
    return { id, held: editsOf(id, sandbox) };
};

// Your own home's next message opens a fresh session; every message stays.
export const startFreshHome = (sandbox: HomeSandbox): SandboxHandlerOutput<`agents`, `startFreshHome`> => {
    const { id } = homeOf(sandbox);
    patchAgent(id, { freshPending: `asked`, sessionId: undefined });
    return { ok: true };
};

// Your own home's messages deleted, and its next message opened fresh on what it has in hand.
export const clearHomeHistory = (sandbox: HomeSandbox): SandboxHandlerOutput<`agents`, `clearHomeHistory`> => {
    const { id, held } = homeOf(sandbox);
    const dropped = editedTranscript(id, sandbox).messages.length;
    held.kept = 0;
    held.placed = [];
    patchAgent(id, { freshPending: `cleared`, sessionId: undefined, contextTokens: undefined });
    return { dropped };
};

const findTool = (tools: readonly TranscriptTool[], toolId: string): TranscriptTool | undefined => {
    for (const tool of tools) {
        const found = tool.id === toolId ? tool : findTool(tool.children ?? [], toolId);
        if (found !== undefined) {
            return found;
        }
    }
    return undefined;
};

// One delegation's own calls, read off the record; empty when the record no longer holds that call. The record's calls
// are typed loosely on the way out (the schema is self-referential), so they are read back through it.
export const toolChildren = ({ id, toolId }: SandboxHandlerInput<`agents`, `toolChildren`>, sandbox: HomeSandbox): SandboxHandlerOutput<`agents`, `toolChildren`> => {
    const calls = TranscriptToolSchema.array().safeParse(editedTranscript(id, sandbox).messages.flatMap((row) => row.tools ?? []));
    return { children: findTool(calls.data ?? [], toolId)?.children ?? [] };
};
