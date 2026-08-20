import { basename } from "node:path";
import { getSessionInfo, getSessionMessages, listSessions } from "@anthropic-ai/claude-agent-sdk";
import type { MatchSnippet, RestoredMessage, RestoredToolCall } from "@intentic/sandbox-contract";
import { stripAttachmentNote } from "../agent/attachment-note.js";
import { parseRuntimeHistory } from "../agent/runtime-history.js";
import { displayNameOf, editDiffContent, resultText, toolCategoryOf, toolLocations, toolTarget } from "../agent/tool-calls.js";
import { unwrapStoredPrompt } from "../agent/turn-preamble.js";
import { matchLines, readSessionLines } from "./transcript-search.js";

// A past conversation in this workspace, for the platform's chat-history list. `title` is the SDK's
// resolved display summary (custom title / auto-summary / first prompt); `updatedAt` is its last-modified ms.
// `snippet` is set only by a search, and only when the hit was in a line the title doesn't already show.
export interface SessionSummary {
    readonly id: string;
    readonly title: string;
    readonly updatedAt: number;
    readonly snippet?: MatchSnippet;
}

// The `message` field of a stored turn is an Anthropic message: content is a string or a block array. The
// block union is the stored counterpart of what the live stream yields per turn, prose, extended thinking,
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
// ponytail: Claude sessions only, this is the HISTORY MENU, which lists runtime sessions rather than fleet
// conversations (those are the board's, and read back through /agents/:id/transcript whatever served them).
// Merge Codex threads here with a provider tag when users ask for Codex history.
// The list title a stored first prompt yields: the user's words with the daemon's injections removed, an
// opening turn preamble ("Dependencies are NOT installed…"), a re-run's interruption note, and the trailing
// attachment note. An attachment-only opener is titled by what was dropped in, matching what the send derived
// locally.
const promptTitle = (firstPrompt: string | undefined): string | undefined => {
    if (firstPrompt === undefined) {
        return undefined;
    }
    const { text, attachments } = stripAttachmentNote(unwrapStoredPrompt(firstPrompt).text);
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

/* Filter the history list by a keyword, for the chat-history search box, by the SAME rule the fleet board's
 * filter runs (agents.search): the session's title, and what either side SAID in it. Two search boxes in one
 * window that disagree about what "matches" means is worse than one of them not existing, and the board is
 * literally showing rows from this list underneath its own cards.
 *
 * That rule is also what let the old per-session content cap go. This used to read transcripts for the ten
 * most recent sessions only, because each hit cost a full readWorkspaceSession (tool cards, call-time diffs,
 * result settling, all of it thrown away by a substring test). readSessionLines reads the spoken text alone
 * and holds it, so scanning the whole listed set costs one pass per session for the life of the daemon.
 *
 * Result keeps the newest-first order of `list`. A session whose TITLE matched carries no snippet: the title
 * is the row's own heading, and repeating it under itself is noise rather than evidence.
 *
 * `caseSensitive` is that same shared rule's other half, the Aa switch in the field, which the board applies to
 * its cards and these rows in one pass, so one query cannot come back matched two ways.
 */
export const searchWorkspaceSessions = async (dir: string, query: string, caseSensitive: boolean): Promise<SessionSummary[]> => {
    const needle = caseSensitive ? query : query.toLowerCase();
    const sessions = await listWorkspaceSessions(dir);
    const matched = await Promise.all(
        sessions.map(async (session): Promise<SessionSummary | undefined> => {
            if ((caseSensitive ? session.title : session.title.toLowerCase()).includes(needle)) {
                return session;
            }
            const snippet = matchLines(await readSessionLines(dir, session.id), needle, caseSensitive);
            // Object.assign, not a spread, these summaries are this call's own, built fresh by the list above.
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
    // A plain-string content is a bare user prompt, the one block shape the store writes unwrapped.
    return typeof content === "string" ? [{ type: "text", text: content }] : (content ?? []);
};

// Rebuild one stored session as the transcript a reopened tab redraws: prose, extended thinking, and the tool
// cards each turn ran, derived from the SAME tool-calls helpers the live stream maps through (so a restored
// card is indistinguishable from the one it replaces). `dir` is the turn's working dir, tool locations and
// diff paths are relative to it, exactly as they were when streamed.
//
// The bubble boundary is the PROSE BLOCK, not the stored message, see restoredSessionMessages.
export const readWorkspaceSession = async (dir: string, id: string): Promise<RestoredMessage[]> => {
    // The dir-scoped read covers the workspace root and its LIVE worktrees, the SDK resolves worktree
    // project dirs through `git worktree list`. An ARCHIVED agent's transcript is keyed by its retired
    // worktree path, which that list no longer names, so the scoped search comes back empty with the file
    // sitting right in this workspace's own store (~/.claude/projects is symlinked per sandbox, see
    // session-store.ts). Fall back to the all-projects search before calling the session empty; ids are
    // UUIDs, so the widened search can only find the session that was asked for.
    const scoped = await getSessionMessages(id, { dir });
    return restoredSessionMessages(scoped.length > 0 ? scoped : await getSessionMessages(id), dir);
};

/* The stored-message → transcript reduction itself, over whatever set of SDK session messages it is handed.
 * Exported because a SUBAGENT's transcript is the same file format read from a different file
 * (getSubagentMessages, see sessions/subagent-transcript.ts): one reducer, so a delegation's transcript and its
 * parent's are assembled by identical rules and cannot come to disagree about what a stored turn looks like.
 *
 * THE BUBBLE BOUNDARY IS THE PROSE BLOCK, exactly as it is live (`text_end`, see turn-transcript.ts's fold and
 * the client's turnReducer): everything an assistant writes accumulates into one bubble, and a text block ending
 * closes it, so the calls a paragraph introduced sit under that paragraph and the next paragraph opens a fresh
 * bubble below them.
 *
 * It used to be one bubble per stored MESSAGE, on the assumption that the store files a fresh assistant message
 * around each prose block. It files one around each CONTENT block, so a turn that made fourteen calls between
 * two sentences restored as fourteen one-call bubbles, and a reopened chat showed a ladder of fourteen separate
 * runs where it had shown a single run of fourteen while it streamed. Reading a conversation back must not
 * rearrange it. */
export const restoredSessionMessages = (
    messages: readonly { readonly type?: string; readonly message?: unknown }[],
    dir: string,
): RestoredMessage[] => {
    const out: RestoredMessage[] = [];
    // The bubble being written into, opened by the first thing that lands in it and closed by a prose block (or
    // by the next thing the user says). Kept OPEN across the tool_result messages between two calls: those are
    // the SDK's plumbing, and closing on one is what split a turn's run into a card apiece.
    let bubble: { text: string; thinking: string; tools: RestoredToolCall[] } | undefined;
    const open = (): { text: string; thinking: string; tools: RestoredToolCall[] } => (bubble ??= { text: "", thinking: "", tools: [] });
    // Mirrors the daemon's own `flush`: a bubble that produced nothing at all is not a row.
    const flush = (): void => {
        const current = bubble;
        bubble = undefined;
        if (current === undefined || (current.text.length === 0 && current.thinking.length === 0 && current.tools.length === 0)) {
            return;
        }
        out.push({
            role: "assistant",
            text: current.text,
            ...(current.thinking.length > 0 ? { thinking: current.thinking } : {}),
            ...(current.tools.length > 0 ? { tools: current.tools } : {}),
        });
    };
    // tool_use id → the card to settle when its result arrives on the following (synthetic) user message. The
    // card is in the open bubble or already in `out`; either way it is mutated in place, so a result that lands
    // after its bubble closed needs no second pass.
    const awaiting = new Map<string, RestoredToolCall>();
    // Which cards carry a call-time diff: a successful Edit/Write result is the redundant "file updated"
    // snippet, so the diff stays the card's content. Errors DO replace it (the text is the reason), the same
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
            // Neither is an injected turn preamble or the trailing attachment note, the stored prompt
            // carries them, the redrawn bubble must not: the note's paths become attachment chips again
            // (workspace-relative, the shape the client uploads and fetches previews by; the turn resolved
            // them against the main root even for worktree turns, so `dir`, always the root here, is the
            // right base). An attachment-only message strips to empty text but still redraws its chips.
            if (text.length > 0) {
                // Words of their own, so whatever the agent was still writing into is finished and closed above
                // them. (A tool_result-only message never reaches here, which is the point.)
                flush();
                const unwrapped = unwrapStoredPrompt(text);
                /* A turn the daemon re-ran after an interruption stores the original prompt behind a note saying
                 * why (RESUME_NOTES), read exactly as the daemon's own record reads it (turn-transcript.ts): a
                 * re-run of words this transcript already holds becomes the muted line explaining the gap, in
                 * place of a second copy of the message; a restored card's answer keeps its words and carries the
                 * explanation as a note. */
                const resume = unwrapped.resume;
                if (resume?.kind === "notice") {
                    out.push({ role: "notice", text: resume.text });
                    continue;
                }
                const stripped = stripAttachmentNote(unwrapped.text);
                const attachments = stripped.attachments.map((path) => (path.startsWith(`${dir}/`) ? path.slice(dir.length + 1) : path));
                // …and the preamble that was just stripped, kept on the message it was added to. Removing it from
                // the user's words is only half of being honest about it; carrying it is the other half, and it
                // reads the same here as on the daemon's own record.
                const notes = [...unwrapped.notes, ...(resume?.kind === "note" ? [resume.note] : [])];
                const added = notes.length > 0 ? { notes } : {};
                const runtime = parseRuntimeHistory(stripped.text);
                if (runtime !== undefined) {
                    out.push(...runtime.history);
                    if (runtime.prompt.length > 0 || attachments.length > 0) {
                        out.push({ role: "user", text: runtime.prompt, ...(attachments.length > 0 ? { attachments } : {}), ...added });
                    }
                } else if (stripped.text.length > 0 || attachments.length > 0) {
                    out.push({ role: "user", text: stripped.text, ...(attachments.length > 0 ? { attachments } : {}), ...added });
                }
            }
            continue;
        }

        for (const block of blocks) {
            if (block.type === "text" && typeof block.text === "string") {
                const current = open();
                current.text += block.text;
                // The block ended here, and a block that WROTE something closes its bubble, the live
                // `text_end` rule, down to the empty-block exemption (a model can open a text block and go
                // straight to a tool; retiring on that would strand the bubble empty).
                if (current.text.length > 0) {
                    flush();
                }
            } else if (block.type === "thinking" && typeof block.thinking === "string") {
                open().thinking += block.thinking;
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
                open().tools.push(tool);
                awaiting.set(block.id, tool);
            }
        }
    }
    // The last bubble of the session closes at the end of it, a turn that finished on a tool call (or was
    // interrupted mid-call) never wrote the prose that would have closed it.
    flush();
    return out;
};
