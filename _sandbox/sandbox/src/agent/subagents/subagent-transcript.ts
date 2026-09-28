import type { TranscriptRow, TranscriptTool } from "@intentic/sandbox-contract";
import { ORPCError } from "@orpc/server";
import type { ConversationActors } from "../../conversations/actor/conversation-actors.js";
import { turnRunOf } from "../../conversations/actor/conversation-holdings.js";
import { toolIn, type TranscriptAgent } from "../../sessions/agent-transcript.js";
import { subagentSource } from "./subagents.js";

// One in-process subagent's own transcript: what a subagent its parent's runtime ran inside the parent's turn asked,
// thought, called and said, in the shape every transcript route answers in, so the chat draws it with its own rows. A
// spawned subagent is a conversation and is read as one (`agents.transcript`); this is for the kind that has none.
//
// Two stores, the fuller first:
// - the Claude runtime keeps each subagent's record beside its session, written as the subagent works, so it serves a
//   running one as well as a settled one, prose included;
// - every runtime's delegation card holds the subagent's calls and thinking under it in the parent's own record (the
//   live run's rows while the turn runs), which is all there is for another runtime, or once the roster let go of the
//   record that says where the Claude file is.
// Empty is a real answer: nothing recorded yet.

export interface SubagentTranscriptDeps {
    readonly conversations: Pick<ConversationActors, "holdings">;
    // The Claude runtime's own record of one subagent, reduced to rows the way a session is; empty when it has none.
    readonly sdkMessages: (sessionId: string, agentId: string) => Promise<TranscriptRow[]>;
    // A delegation's card whole, as a conversation's settled record holds it: its calls, and its result.
    readonly toolCard: (agent: TranscriptAgent, toolId: string) => Promise<TranscriptTool | undefined>;
}

// The ask, as the first user bubble: the calls alone carry no prompt of their own.
const askedOf = (asked: string | undefined): TranscriptRow[] =>
    asked !== undefined && asked.trim().length > 0 ? [{ role: "user", text: asked }] : [];

// What the subagent reported, as its parent read it: the text of the delegation's result, empty while it works.
const reportOf = (card: TranscriptTool): string =>
    (card.content ?? [])
        .flatMap((entry) => (entry.type === "text" ? [entry.text] : []))
        .join("\n\n")
        .trim();

// The delegation's card, from the parent's run while it is held (fresher than the record, which is written as rows
// settle), else from the parent's record.
const cardOf = async (deps: SubagentTranscriptDeps, parentId: string, id: string): Promise<TranscriptTool | undefined> => {
    const rows = turnRunOf(deps.conversations, parentId)?.rows ?? [];
    for (let index = rows.length - 1; index >= 0; index -= 1) {
        const held = toolIn(rows[index]?.tools ?? [], id);
        if (held !== undefined) {
            return held;
        }
    }
    return deps.toolCard({ id: parentId }, id);
};

export const readSubagentTranscript = async (deps: SubagentTranscriptDeps, parentId: string, id: string): Promise<TranscriptRow[]> => {
    const source = await subagentSource(deps.conversations, id);
    if (source !== undefined && source.conversationId !== parentId) {
        throw new ORPCError("NOT_FOUND", { message: "no subagent of this conversation has that id" });
    }
    if (source?.kind === "spawned") {
        throw new ORPCError("BAD_REQUEST", { message: "a spawned subagent is a conversation of its own: read its transcript" });
    }
    if (source?.sdk !== undefined) {
        const own = await deps.sdkMessages(source.sdk.sessionId, source.sdk.agentId);
        if (own.length > 0) {
            return own;
        }
    }
    const card = await cardOf(deps, parentId, id);
    const calls = card?.children ?? [];
    const report = card === undefined ? "" : reportOf(card);
    if (card === undefined || (calls.length === 0 && report === "")) {
        return [];
    }
    return [...askedOf(source?.description ?? card.target), { role: "assistant", text: report, ...(calls.length > 0 ? { tools: calls } : {}) }];
};
