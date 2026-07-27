import { getSessionInfo, getSessionMessages, listSessions } from "@anthropic-ai/claude-agent-sdk";
import type { RestoredMessage, RestoredToolCall } from "@intentic/sandbox-contract";
import { editDiffContent, resultText, toolCategoryOf, toolLocations, toolTarget } from "../agent/tool-calls.js";

// A past conversation in this workspace, for the platform's chat-history list. `title` is the SDK's
// resolved display summary (custom title / auto-summary / first prompt); `updatedAt` is its last-modified ms.
export interface SessionSummary {
    readonly id: string;
    readonly title: string;
    readonly updatedAt: number;
}

// The `message` field of a stored turn is an Anthropic message: content is a string or a block array. The
// block union is the stored counterpart of what the live stream yields per turn — prose, extended thinking,
// the tool calls the turn made, and (on the synthetic user messages between assistant turns) their results.
interface StoredBlock {
    type?: string;
    text?: string;
    thinking?: string;
    id?: string;
    name?: string;
    input?: unknown;
    tool_use_id?: string;
    content?: unknown;
    is_error?: boolean;
}
interface AnthropicMessageLike {
    content?: string | StoredBlock[];
}

// List the workspace's past Claude sessions (newest first, capped) for the history menu. Sessions are
// persisted by the SDK keyed on the working dir, so passing the workspace root scopes them to this sandbox.
// ponytail: Claude sessions only — Codex threads persist as rollout JSONL under CODEX_HOME/sessions and a live
// Codex tab resumes fine; merge them here with a provider tag when users ask for Codex history.
export const listWorkspaceSessions = async (dir: string): Promise<SessionSummary[]> => {
    const sessions = await listSessions({ dir, limit: 50 });
    return sessions.map((session) => ({
        id: session.sessionId,
        title: session.customTitle ?? session.summary ?? session.firstPrompt ?? "New chat",
        updatedAt: session.lastModified,
    }));
};

// Filter the history list by a keyword, for the chat-history search box. Titles are matched across every
// listed session (cheap, already loaded); content is scanned only for the most recent `contentLimit` sessions,
// since each content match reads that session's transcript. Result keeps the newest-first order of `list`.
// ponytail: case-insensitive substring scan, content read for ≤contentLimit recent sessions; add an index or
// ranking if recall over older chats matters.
export const searchWorkspaceSessions = async (dir: string, query: string, contentLimit = 10): Promise<SessionSummary[]> => {
    const needle = query.toLowerCase();
    const sessions = await listWorkspaceSessions(dir);
    const contentHits = await Promise.all(
        sessions.slice(0, contentLimit).map(async (session) => {
            if (session.title.toLowerCase().includes(needle)) {
                return false; // Already a title match; no need to read the transcript.
            }
            const messages = await readWorkspaceSession(dir, session.id);
            return messages.some((message) => message.text.toLowerCase().includes(needle));
        }),
    );
    return sessions.filter((session, index) => session.title.toLowerCase().includes(needle) || contentHits[index] === true);
};

// Cheap existence probe for the pre-flight resume check: getSessionInfo reads only that session's file
// (listSessions scans the whole project and is capped). undefined ⇒ nothing to resume.
export const workspaceSessionExists = async (dir: string, id: string): Promise<boolean> => (await getSessionInfo(id, { dir })) !== undefined;

const blocksOf = (message: { message?: unknown }): StoredBlock[] => {
    const content = (message.message as AnthropicMessageLike | undefined)?.content;
    // A plain-string content is a bare user prompt — the one block shape the store writes unwrapped.
    return typeof content === "string" ? [{ type: "text", text: content }] : (content ?? []);
};

// Rebuild one stored session as the transcript a reopened tab redraws: prose, extended thinking, and the tool
// cards each turn ran, derived from the SAME tool-calls helpers the live stream maps through (so a restored
// card is indistinguishable from the one it replaces). `dir` is the turn's working dir — tool locations and
// diff paths are relative to it, exactly as they were when streamed.
//
// One bubble per stored assistant message, which is what reproduces the live interleaving: the SDK emits a
// fresh assistant message around each prose block, so its tool_use blocks land under the prose that
// introduced them instead of all hanging off the end of the turn.
export const readWorkspaceSession = async (dir: string, id: string): Promise<RestoredMessage[]> => {
    const messages = await getSessionMessages(id, { dir });
    const out: RestoredMessage[] = [];
    // tool_use id → the card to settle when its result arrives on the following (synthetic) user message. The
    // card is already in `out`; it is mutated in place, so ordering needs no second pass.
    const awaiting = new Map<string, RestoredToolCall>();
    // Which cards carry a call-time diff: a successful Edit/Write result is the redundant "file updated"
    // snippet, so the diff stays the card's content. Errors DO replace it (the text is the reason) — the same
    // rule the live tool_call_update applies.
    const diffed = new Set<string>();

    for (const message of messages) {
        if (message.type !== "user" && message.type !== "assistant") {
            continue;
        }
        const blocks = blocksOf(message);

        if (message.type === "user") {
            let text = "";
            for (const block of blocks) {
                if (block.type === "text" && typeof block.text === "string") {
                    text += block.text;
                    continue;
                }
                if (block.type !== "tool_result" || block.tool_use_id === undefined) {
                    continue;
                }
                const tool = awaiting.get(block.tool_use_id);
                if (tool === undefined) {
                    continue;
                }
                awaiting.delete(block.tool_use_id);
                const failed = block.is_error === true;
                tool.status = failed ? "failed" : "completed";
                if (failed || !diffed.has(tool.id)) {
                    tool.content = [{ type: "text", text: resultText(block.content) }];
                }
            }
            // A user message carrying only tool_results is the SDK's plumbing, not something the user said.
            if (text.length > 0) {
                out.push({ role: "user", text });
            }
            continue;
        }

        let text = "";
        let thinking = "";
        const tools: RestoredToolCall[] = [];
        for (const block of blocks) {
            if (block.type === "text" && typeof block.text === "string") {
                text += block.text;
            } else if (block.type === "thinking" && typeof block.thinking === "string") {
                thinking += block.thinking;
            } else if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
                const target = toolTarget(block.input);
                const locations = toolLocations(block.input, dir);
                const diff = editDiffContent(block.name, block.input, dir);
                if (diff !== undefined) {
                    diffed.add(block.id);
                }
                const tool: RestoredToolCall = {
                    id: block.id,
                    name: block.name,
                    category: toolCategoryOf(block.name),
                    // No result in the file ⇒ the turn was interrupted mid-call; the card says so rather than
                    // claiming a completion that never happened.
                    status: "in_progress",
                    ...(target !== undefined ? { target } : {}),
                    ...(locations !== undefined ? { locations } : {}),
                    ...(diff !== undefined ? { content: [diff] } : {}),
                };
                tools.push(tool);
                awaiting.set(block.id, tool);
            }
        }
        if (text.length > 0 || thinking.length > 0 || tools.length > 0) {
            out.push({
                role: "assistant",
                text,
                ...(thinking.length > 0 ? { thinking } : {}),
                ...(tools.length > 0 ? { tools } : {}),
            });
        }
    }
    return out;
};
