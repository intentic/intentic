import { basename } from "node:path";
import { sdk } from "../runtimes/claude/claude-sdk.js";
import {
    AskQuestionSchema,
    type MatchSnippet,
    settledCards,
    type TodoItem,
    type TranscriptQuestion,
    type TranscriptRow,
    type TranscriptTool,
} from "@intentic/sandbox-contract";
import { z } from "zod";
import { stripAttachmentNote } from "../agent/prompt/attachment-note.js";
import { ASK_TOOL_NAMES, parseAnswers } from "../agent/tools/question-answers.js";
import { parseRuntimeHistory } from "../agent/providers/runtime-history.js";
import { TaskChecklist } from "../agent/run/task-checklist.js";
import { displayNameOf, editDiffContent, resultText, toolCategoryOf, toolLocations, toolTarget } from "../agent/tools/tool-calls.js";
import { unwrapStoredPrompt } from "../agent/prompt/turn-preamble.js";
import type { SearchIndex } from "./search-index.js";
import { matchLines, sessionOverlay } from "./transcript-search.js";

// The index's own search, passed in rather than imported, since this module knows how to ask what a session said, not
// where the index lives.
type SaidLookup = (...args: Parameters<SearchIndex["search"]>) => Promise<ReturnType<SearchIndex["search"]>>;

// A past conversation for the chat-history list. `title` is the SDK's resolved display summary; `updatedAt` is
// last-modified ms; `snippet` is set only by a search, and only when the title doesn't already show the hit.
export interface SessionSummary {
    readonly id: string;
    readonly title: string;
    readonly updatedAt: number;
    readonly snippet?: MatchSnippet;
}

// A stored turn's `message.content` is a string or this block union: prose, extended thinking, tool calls, and (on the
// synthetic user messages between turns) their results.
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

// Sessions are the SDK's per-dir history menu, not fleet board conversations. The title from a stored first prompt
// strips daemon injections; an attachment-only opener titles by what was dropped in.
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
    const sessions = await sdk().listSessions({ dir, limit: 50 });
    return sessions.map((session) => ({
        id: session.sessionId,
        title: session.customTitle ?? session.summary ?? promptTitle(session.firstPrompt) ?? "New chat",
        updatedAt: session.lastModified,
    }));
};

// A short-TTL cache over the session list, so a burst of keystrokes shares one listing; never invalidated, since
// staying wrong that briefly is invisible. A factory, not a module-level cache, so callers (and tests) don't share
// hidden state.
export type RecentSessions = () => Promise<SessionSummary[]>;

const LIST_TTL_MS = 400;

export const createRecentSessions = (dir: string): RecentSessions => {
    let listed: { at: number; sessions: SessionSummary[] } | undefined;
    return async () => {
        const held = listed;
        if (held !== undefined && Date.now() - held.at < LIST_TTL_MS) {
            return held.sessions;
        }
        const sessions = await listWorkspaceSessions(dir);
        listed = { at: Date.now(), sessions };
        return sessions;
    };
};

// Filters the history list by the fleet board's own rule (title, or what either side said), off the shared index, so
// the two boxes agree. Keeps newest-first order; a title match carries no snippet.
export const searchWorkspaceSessions = async (
    recent: RecentSessions,
    query: string,
    caseSensitive: boolean,
    said: SaidLookup,
): Promise<SessionSummary[]> => {
    const needle = caseSensitive ? query : query.toLowerCase();
    const sessions = await recent();
    const hits = await said(query, "session", caseSensitive);
    // Copies, never the cached objects: writing a snippet onto one would leak into the next query.
    return sessions.flatMap(({ snippet: _stale, ...session }): SessionSummary[] => {
        if ((caseSensitive ? session.title : session.title.toLowerCase()).includes(needle)) {
            return [session];
        }
        const indexed = hits.get(session.id);
        // The write-lag overlay: a prompt sent since boot with no settled turn yet, so it isn't in the index.
        const pending = matchLines(sessionOverlay(session.id), needle, caseSensitive);
        // The user's own words win, oldest first, the same ordering rule the index itself applies.
        const snippet = indexed?.speaker === "user" ? indexed : pending?.speaker === "user" ? pending : (indexed ?? pending);
        return snippet === undefined ? [] : [{ ...session, snippet }];
    });
};

// Cheap existence probe: getSessionInfo reads only this session's file, unlike listSessions which scans the capped
// project list.
export const workspaceSessionExists = async (dir: string, id: string): Promise<boolean> => (await sdk().getSessionInfo(id, { dir })) !== undefined;

// The ask tool's input as the store keeps it: the same questions the live `question` frame carried.
const AskInputSchema = z.object({ questions: z.array(AskQuestionSchema).min(1) });

const blocksOf = (message: { message?: unknown }): StoredBlock[] => {
    const content = (message.message as AnthropicMessageLike | undefined)?.content;
    // A plain-string content is a bare user prompt, the one block shape the store writes unwrapped.
    return typeof content === "string" ? [{ type: "text", text: content }] : (content ?? []);
};

// Rebuilds a session with the same tool-calls helpers the live stream uses, so a restored card matches the original;
// `dir` is the turn's working dir. The bubble boundary is the prose block, not the stored message.
export const readWorkspaceSession = async (dir: string, id: string): Promise<TranscriptRow[]> => {
    // A retired worktree is outside the dir scope; fall back to the all-projects search instead of empty.
    const scoped = await sdk().getSessionMessages(id, { dir });
    return restoredSessionMessages(scoped.length > 0 ? scoped : await sdk().getSessionMessages(id), dir);
};

// Index where the last turn begins: a user message carrying words opens a turn; a tool_result-only user message is
// plumbing, not a boundary. Returns 0 (restoring everything) when nothing carries words.
const lastTurnStart = (messages: readonly { readonly type?: string; readonly message?: unknown }[]): number => {
    for (let index = messages.length - 1; index >= 0; index -= 1) {
        const message = messages[index];
        if (message?.type !== "user") {
            continue;
        }
        const spoken = blocksOf(message).some((block) => block.type === "text" && typeof block.text === "string" && block.text.length > 0);
        if (spoken) {
            return index;
        }
    }
    return 0;
};

// The last stored turn alone, restored by the same reducer, for a turn the daemon died under and never reached the
// durable record. Its boundary is read off the stored messages, not the restored ones.
export const readWorkspaceSessionTail = async (dir: string, id: string): Promise<TranscriptRow[]> => {
    const scoped = await sdk().getSessionMessages(id, { dir });
    const messages = scoped.length > 0 ? scoped : await sdk().getSessionMessages(id);
    return restoredSessionMessages(messages.slice(lastTurnStart(messages)), dir);
};

// The stored-message reducer, shared with a subagent's transcript so both assemble by identical rules. The bubble
// boundary is the prose block (`text_end`), exactly as the live stream draws it.
export const restoredSessionMessages = (
    messages: readonly { readonly type?: string; readonly message?: unknown }[],
    dir: string,
): TranscriptRow[] => {
    const out: TranscriptRow[] = [];
    // The open bubble; stays open across tool_result messages between calls, since closing on one would split one run
    // into a card apiece.
    let bubble: { text: string; thinking: string; tools: TranscriptTool[]; question?: TranscriptQuestion; todos?: TodoItem[] } | undefined;
    const open = (): NonNullable<typeof bubble> => (bubble ??= { text: "", thinking: "", tools: [] });
    // Mirrors the daemon's own `flush`: a bubble that produced nothing at all is not a row.
    const flush = (): void => {
        const current = bubble;
        bubble = undefined;
        if (
            current === undefined ||
            (current.text.length === 0 && current.thinking.length === 0 && current.tools.length === 0 && current.question === undefined && (current.todos === undefined || current.todos.length === 0))
        ) {
            return;
        }
        out.push({
            role: "assistant",
            text: current.text,
            ...(current.thinking.length > 0 ? { thinking: current.thinking } : {}),
            ...(current.tools.length > 0 ? { tools: current.tools } : {}),
            ...(current.todos !== undefined && current.todos.length > 0 ? { todos: current.todos } : {}),
            ...(current.question === undefined ? {} : { question: current.question }),
        });
    };
    // The working checklist reassembled from the Task tool family, matching the live sdk-stream.
    const checklist = new TaskChecklist();
    const checklistToolIds = new Set<string>();
    // Renders onto the open bubble only when the checklist actually moved; an unrecognised patch or result leaves the
    // last list standing.
    const showTodos = (items: TodoItem[] | undefined): void => {
        if (items !== undefined) {
            open().todos = items;
        }
    };
    // A create renders only from its result (where it learns its task id); an update names the id in its input, so the
    // list moves at call time; a TaskList renders from its result alone.
    const checklistCall = (id: string, name: string, input: unknown): void => {
        checklistToolIds.add(id);
        if (name === "TaskCreate") {
            checklist.created(id, input);
            return;
        }
        if (name === "TaskUpdate") {
            showTodos(checklist.updated(input));
        }
    };
    // tool_use id to its card, mutated in place on result, whether still open or already flushed to `out`.
    const awaiting = new Map<string, TranscriptTool>();
    // tool_use id to the question it asked, rebuilt since the store never saw the live question/reply frames.
    const asked = new Map<string, TranscriptQuestion>();
    // Cards with a call-time diff; a successful result is a redundant confirmation, an error replaces it instead.
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
                if (checklistToolIds.has(block.tool_use_id)) {
                    checklistToolIds.delete(block.tool_use_id);
                    const content = resultText(block.content);
                    showTodos(checklist.resolved(block.tool_use_id, content) ?? checklist.listed(content));
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
                // The ask's result is the user's answer; unparsed text leaves the card unanswered, not wearing a
                // decision.
                const question = asked.get(block.tool_use_id);
                const reply = question === undefined ? undefined : parseAnswers(question.questions, block.tool_use_id, resultText(block.content));
                if (question !== undefined && reply !== undefined) {
                    Object.assign(question, settledCards({ question }, reply).question);
                }
            }
            // Tool-results-only and injected notes aren't user words; chips resolve against `dir`, always the root.
            if (text.length === 0) {
                continue;
            }
            // Real words close whatever bubble was still open above them; a tool_results-only message never reaches
            // here.
            flush();
            const unwrapped = unwrapStoredPrompt(text);
            // A re-run's resumed prompt becomes a muted line, not a duplicate; its note rides separately on the card.
            const resume = unwrapped.resume;
            if (resume?.kind === "notice") {
                out.push({ role: "notice", text: resume.text });
                continue;
            }
            const stripped = stripAttachmentNote(unwrapped.text);
            const attachments = stripped.attachments.map((path) => (path.startsWith(`${dir}/`) ? path.slice(dir.length + 1) : path));
            // The stripped preamble rides along as a note, read the same way the daemon's own record keeps it.
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
            continue;
        }

        for (const block of blocks) {
            if (block.type === "text" && typeof block.text === "string") {
                const current = open();
                current.text += block.text;
                // A block that wrote something closes its bubble; an empty one does not, so a bare tool call doesn't
                // strand it.
                if (current.text.length > 0) {
                    flush();
                }
            } else if (block.type === "thinking" && typeof block.thinking === "string") {
                open().thinking += block.thinking;
            } else if (block.type === "tool_use" && typeof block.id === "string" && typeof block.name === "string") {
                if (block.name === "TaskCreate" || block.name === "TaskList" || block.name === "TaskUpdate") {
                    checklistCall(block.id, block.name, block.input);
                    continue;
                }
                // The ask's card lands one frame ahead of its call, closing the bubble so the call sits beneath the
                // prose.
                const ask = ASK_TOOL_NAMES.has(block.name) ? AskInputSchema.safeParse(block.input) : undefined;
                if (ask?.success === true) {
                    const question: TranscriptQuestion = { requestId: block.id, questions: ask.data.questions, status: "pending" };
                    open().question = question;
                    flush();
                    asked.set(block.id, question);
                }
                const target = toolTarget(block.input);
                const locations = toolLocations(block.input, dir);
                const diff = editDiffContent(block.name, block.input, dir);
                if (diff !== undefined) {
                    diffed.add(block.id);
                }
                const tool: TranscriptTool = {
                    id: block.id,
                    // Same normalization the live stream applies, so a restored card doesn't revert to the raw MCP tool
                    // id.
                    name: displayNameOf(block.name),
                    category: toolCategoryOf(block.name),
                    // No result in the file means the turn was interrupted mid-call, not completed.
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
    // Closes the last bubble: a turn that ended on (or was interrupted at) a tool call never wrote closing prose.
    flush();
    return out;
};
