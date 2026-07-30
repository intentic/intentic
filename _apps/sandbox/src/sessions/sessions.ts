import { basename } from "node:path";
import { getSessionInfo, getSessionMessages, listSessions } from "@anthropic-ai/claude-agent-sdk";
import type { RestoredMessage, RestoredToolCall } from "@intentic/sandbox-contract";
import { stripAttachmentNote } from "../agent/attachment-note.js";
import { parseRuntimeHistory } from "../agent/runtime-history.js";
import { displayNameOf, editDiffContent, resultText, toolCategoryOf, toolLocations, toolTarget } from "../agent/tool-calls.js";
import { stripTurnPreamble } from "../agent/turn-preamble.js";
import { matchPrompts, readSessionPrompts } from "./prompt-index.js";

// A past conversation in this workspace, for the platform's chat-history list. `title` is the SDK's
// resolved display summary (custom title / auto-summary / first prompt); `updatedAt` is its last-modified ms.
// `snippet` is set only by a search, and only when the hit was in a prompt the title doesn't already show.
export interface SessionSummary {
    readonly id: string;
    readonly title: string;
    readonly updatedAt: number;
    readonly snippet?: string;
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
// The list title a stored first prompt yields: the user's words with the daemon's injections removed — an
// opening turn preamble ("Dependencies are NOT installed…") and the trailing attachment note. An
// attachment-only opener is titled by what was dropped in, matching what the send derived locally.
const promptTitle = (firstPrompt: string | undefined): string | undefined => {
    if (firstPrompt === undefined) {
        return undefined;
    }
    const { text, attachments } = stripAttachmentNote(stripTurnPreamble(firstPrompt));
    const runtime = parseRuntimeHistory(text);
    const title = runtime?.history.find((message) => message.role === "user")?.text ?? runtime?.prompt ?? text;
    return title.length > 0 ? title : attachments.map((path) => basename(path)).join(", ") || undefined;
};

export const listWorkspaceSessions = async (dir: string): Promise<SessionSummary[]> => {
    const sessions = await listSessions({ dir, limit: 50 });
    return sessions.map((session) => ({
        id: session.sessionId,
        title: session.customTitle ?? session.summary ?? promptTitle(session.firstPrompt) ?? "New chat",
        updatedAt: session.lastModified,
    }));
};

/* Filter the history list by a keyword, for the chat-history search box — by the SAME rule the fleet board's
 * filter runs (agents.search): the session's title, and the prompts the USER wrote in it. Two search boxes in
 * one window that disagree about what "matches" means is worse than one of them not existing.
 *
 * That rule is also what let the old per-session content cap go. This used to read transcripts for the ten
 * most recent sessions only, because each hit cost a full readWorkspaceSession (tool cards, call-time diffs,
 * result settling — all of it thrown away by a substring test). readSessionPrompts reads the user half alone
 * and holds it, so scanning the whole listed set costs one pass per session for the life of the daemon.
 *
 * Result keeps the newest-first order of `list`. A session whose TITLE matched carries no snippet: the title
 * is the row's own heading, and repeating it under itself is noise rather than evidence.
 */
export const searchWorkspaceSessions = async (dir: string, query: string): Promise<SessionSummary[]> => {
    const needle = query.toLowerCase();
    const sessions = await listWorkspaceSessions(dir);
    const matched = await Promise.all(
        sessions.map(async (session): Promise<SessionSummary | undefined> => {
            if (session.title.toLowerCase().includes(needle)) {
                return session;
            }
            const snippet = matchPrompts(await readSessionPrompts(dir, session.id), needle);
            // Object.assign, not a spread — these summaries are this call's own, built fresh by the list above.
            return snippet === undefined ? undefined : Object.assign(session, { snippet });
        }),
    );
    return matched.filter((session) => session !== undefined);
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
    // The dir-scoped read covers the workspace root and its LIVE worktrees — the SDK resolves worktree
    // project dirs through `git worktree list`. An ARCHIVED agent's transcript is keyed by its retired
    // worktree path, which that list no longer names, so the scoped search comes back empty with the file
    // sitting right in this workspace's own store (~/.claude/projects is symlinked per sandbox — see
    // session-store.ts). Fall back to the all-projects search before calling the session empty; ids are
    // UUIDs, so the widened search can only find the session that was asked for.
    const scoped = await getSessionMessages(id, { dir });
    const messages = scoped.length > 0 ? scoped : await getSessionMessages(id);
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
            // Neither is an injected turn preamble or the trailing attachment note — the stored prompt
            // carries them, the redrawn bubble must not: the note's paths become attachment chips again
            // (workspace-relative, the shape the client uploads and fetches previews by; the turn resolved
            // them against the main root even for worktree turns, so `dir` — always the root here — is the
            // right base). An attachment-only message strips to empty text but still redraws its chips.
            if (text.length > 0) {
                const stripped = stripAttachmentNote(stripTurnPreamble(text));
                const attachments = stripped.attachments.map((path) => (path.startsWith(`${dir}/`) ? path.slice(dir.length + 1) : path));
                const runtime = parseRuntimeHistory(stripped.text);
                if (runtime !== undefined) {
                    out.push(...runtime.history);
                    if (runtime.prompt.length > 0 || attachments.length > 0) {
                        out.push({ role: "user", text: runtime.prompt, ...(attachments.length > 0 ? { attachments } : {}) });
                    }
                } else if (stripped.text.length > 0 || attachments.length > 0) {
                    out.push({ role: "user", text: stripped.text, ...(attachments.length > 0 ? { attachments } : {}) });
                }
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
                    // The same normalization the live stream applies, so a restored card reads exactly like
                    // the one it replaces rather than reverting to the raw MCP tool id.
                    name: displayNameOf(block.name),
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
