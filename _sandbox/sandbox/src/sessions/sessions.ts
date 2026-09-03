import { basename } from "node:path";
import { sdk } from "../claude/claude-sdk.js";
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
import { stripAttachmentNote } from "../agent/attachment-note.js";
import { ASK_TOOL_NAMES, parseAnswers } from "../agent/question-answers.js";
import { parseRuntimeHistory } from "../agent/runtime-history.js";
import { TaskChecklist } from "../agent/task-checklist.js";
import { displayNameOf, editDiffContent, resultText, toolCategoryOf, toolLocations, toolTarget } from "../agent/tool-calls.js";
import { unwrapStoredPrompt } from "../agent/turn-preamble.js";
import type { SearchIndex } from "./search-index.js";
import { matchLines, sessionOverlay } from "./transcript-search.js";

// The index's own search, passed in rather than imported: this module knows how to ask what a session said, not
// where the answer is kept, and the daemon owns exactly one index (see composition.ts).
type SaidLookup = (...args: Parameters<SearchIndex["search"]>) => Promise<ReturnType<SearchIndex["search"]>>;

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
    const sessions = await sdk().listSessions({ dir, limit: 50 });
    return sessions.map((session) => ({
        id: session.sessionId,
        title: session.customTitle ?? session.summary ?? promptTitle(session.firstPrompt) ?? "New chat",
        updatedAt: session.lastModified,
    }));
};

/* THE LIST, CACHED FOR A MOMENT, because a filter re-asks for it on every settled keystroke and the answer
 * cannot meaningfully change between two of them.
 *
 * `listSessions` stats every session file in the project to order them. On the sandbox this was measured
 * against (677 sessions, 1.5 GB) that is 42-128 ms warm and 2.4 s with a cold page cache, and the search path
 * asked for it unconditionally, per query. A window slightly longer than the field's own debounce collapses a
 * burst of keystrokes onto one listing while still noticing a new chat within a moment of it appearing.
 *
 * Deliberately NOT invalidated on anything: a TTL this short cannot go stale in a way anybody sees, and the
 * alternatives (watching the store, hooking every place a session is created) buy nothing for the cost of a
 * second thing that has to stay correct.
 *
 * A FACTORY, not a module-level cache. Held state that outlives a call and answers by the clock is the kind of
 * thing that leaks between two callers who never agreed to share, and a suite cannot get a straight answer out
 * of it at all. The daemon builds exactly one and hands it to the search (see composition.ts). */
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

/* Filter the history list by a keyword, for the chat-history search box, by the SAME rule the fleet board's
 * filter runs (agents.search): the session's title, and what either side SAID in it. Two search boxes in one
 * window that disagree about what "matches" means is worse than one of them not existing, and the board is
 * literally showing rows from this list underneath its own cards.
 *
 * BOTH BOXES NOW READ ONE INDEX (sessions/search-index.ts), which is what finally makes that shared rule a
 * shared implementation rather than two that have to be kept in step. It also removes what made this the
 * slowest route in the daemon: it used to read the SDK's session files on the query path, and those carry every
 * tool call and result, so the spoken few KB came wrapped in tens of megabytes. Measured on a real workspace,
 * the 50 listed sessions were 124 MB and 8.1 s of blocking reads for the first phrase typed after a boot.
 *
 * Result keeps the newest-first order of the list. A session whose TITLE matched carries no snippet: the title
 * is the row's own heading, and repeating it under itself is noise rather than evidence.
 *
 * `caseSensitive` is that same shared rule's other half, the Aa switch in the field, which the board applies to
 * its cards and these rows in one pass, so one query cannot come back matched two ways.
 */
export const searchWorkspaceSessions = async (
    recent: RecentSessions,
    query: string,
    caseSensitive: boolean,
    said: SaidLookup,
): Promise<SessionSummary[]> => {
    const needle = caseSensitive ? query : query.toLowerCase();
    const sessions = await recent();
    const hits = await said(query, "session", caseSensitive);
    /* COPIES, NEVER THE LISTED OBJECTS THEMSELVES. `recent()` caches its array for LIST_TTL_MS and hands the
     * same summary objects back to every query inside that window, so writing a snippet onto one is writing it
     * into the cache: type `abc`, backspace to `ab`, and the row that now matches on its TITLE was rendered
     * with the evidence from a term no longer typed. The title branch therefore has to DROP a snippet as
     * deliberately as the other one adds one — the rule this function states is that a title match carries no
     * snippet, and after a mutation there was one to carry. */
    return sessions.flatMap(({ snippet: _stale, ...session }): SessionSummary[] => {
        if ((caseSensitive ? session.title : session.title.toLowerCase()).includes(needle)) {
            return [session];
        }
        const indexed = hits.get(session.id);
        // The write-lag overlay, the same one the fleet search unions in: a prompt routed into this session
        // since boot that no settled turn has recorded yet, and so cannot be in the index.
        const pending = matchLines(sessionOverlay(session.id), needle, caseSensitive);
        // The user's own words win, and among theirs the oldest, which is the index's own ordering rule.
        const snippet = indexed?.speaker === "user" ? indexed : pending?.speaker === "user" ? pending : (indexed ?? pending);
        return snippet === undefined ? [] : [{ ...session, snippet }];
    });
};

// Cheap existence probe for the pre-flight resume check: getSessionInfo reads only that session's file
// (listSessions scans the whole project and is capped). undefined ⇒ nothing to resume.
export const workspaceSessionExists = async (dir: string, id: string): Promise<boolean> => (await sdk().getSessionInfo(id, { dir })) !== undefined;

// The ask tool's input as the store keeps it: the same questions the live `question` frame carried.
const AskInputSchema = z.object({ questions: z.array(AskQuestionSchema).min(1) });

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
export const readWorkspaceSession = async (dir: string, id: string): Promise<TranscriptRow[]> => {
    // The dir-scoped read covers the workspace root and its LIVE worktrees, the SDK resolves worktree
    // project dirs through `git worktree list`. An ARCHIVED agent's transcript is keyed by its retired
    // worktree path, which that list no longer names, so the scoped search comes back empty with the file
    // sitting right in this workspace's own store (~/.claude/projects is symlinked per sandbox, see
    // session-store.ts). Fall back to the all-projects search before calling the session empty; ids are
    // UUIDs, so the widened search can only find the session that was asked for.
    const scoped = await sdk().getSessionMessages(id, { dir });
    return restoredSessionMessages(scoped.length > 0 ? scoped : await sdk().getSessionMessages(id), dir);
};

/* WHERE THE LAST TURN OF A STORED SESSION BEGINS, as an index into the stored messages.
 *
 * A turn opens at a user message carrying WORDS. That is the same test restoredSessionMessages applies one
 * level down (`text.length > 0`), and it is the whole of the distinction: the store files a `user` message
 * around every tool RESULT too, and those are the SDK's plumbing between two calls of one turn, not somebody
 * speaking. Counting them as boundaries would put the "last turn" in the middle of the last tool call.
 *
 * 0 when nothing in the session carries words, which restores the whole of it, the right answer for a session
 * that holds one unfinished turn and the honest one for a shape this does not recognise. */
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

/* THE LAST TURN OF A STORED SESSION, and only it, restored by the same reducer the whole session goes through.
 *
 * This is what a turn the daemon DIED under reads back as. Such a turn never settled, so it was never appended
 * to the conversation's durable record (transcript-record.ts records per settled turn), and the boot pass is
 * the only chance anything will ever write it down: the journal entry that names it is consumed there
 * (turn-resume.ts). The provider wrote the turn to its own session file as it streamed, so the work is sitting
 * on disk, and one turn is exactly the slice the record is missing.
 *
 * ONE TURN, never the whole session, because the record already holds every turn before it and this appends.
 * The boundary is read here rather than by counting rows the record holds, because the two do not share a
 * coordinate system: the record carries a row per mid-turn `steer` that the provider folds into the turn's own
 * prompt, so the same point in one conversation sits at different indices on the two sides.
 *
 * A RE-RUN opens with a resume note rather than a user row, and needs no special case here: the reducer already
 * turns a prompt wearing one into the muted line that explains the gap (see restoredSessionMessages), which is
 * a turn boundary that is not a `user` row and the reason `lastTurnStart` reads the STORED messages instead of
 * the restored ones. */
export const readWorkspaceSessionTail = async (dir: string, id: string): Promise<TranscriptRow[]> => {
    const scoped = await sdk().getSessionMessages(id, { dir });
    const messages = scoped.length > 0 ? scoped : await sdk().getSessionMessages(id);
    return restoredSessionMessages(messages.slice(lastTurnStart(messages)), dir);
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
): TranscriptRow[] => {
    const out: TranscriptRow[] = [];
    // The bubble being written into, opened by the first thing that lands in it and closed by a prose block (or
    // by the next thing the user says). Kept OPEN across the tool_result messages between two calls: those are
    // the SDK's plumbing, and closing on one is what split a turn's run into a card apiece.
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
    // The list renders onto the open bubble, and only when the checklist actually moved: a patch naming a task
    // this pass never saw, or a result its parsers do not recognise, comes back undefined and must leave the
    // last rendered list standing rather than blanking it.
    const showTodos = (items: TodoItem[] | undefined): void => {
        if (items !== undefined) {
            open().todos = items;
        }
    };
    // The call side of a checklist verb, by the live stream's own rule (sdk-stream's onChecklistCall): a create
    // can only render from its RESULT, which is where it learns its task id; an update names the id in its
    // input, so the list moves at call time; a TaskList renders from its result alone.
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
    // tool_use id → the card to settle when its result arrives on the following (synthetic) user message. The
    // card is in the open bubble or already in `out`; either way it is mutated in place, so a result that lands
    // after its bubble closed needs no second pass.
    const awaiting = new Map<string, TranscriptTool>();
    /* tool_use id → THE QUESTION THAT CALL ASKED, to be answered by the same result. The store never saw the
     * `question` frame or the reply that released it, it has the ask tool's call (the questions, as its input)
     * and its result (the picks, as the text the model read), and those are enough to redraw the card the user
     * answered, which is the one part of a turn killed mid-flight a person actually did something in. Only the
     * question is rebuilt here: a plan's text lives in prose the store does not mark, and a permission gate is
     * no tool call at all, so neither has a stored shape to read back. The record (turn-transcript.ts) keeps all
     * of them typed; this is the recovery for the turns that never reached it. */
    const asked = new Map<string, TranscriptQuestion>();
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
                // The ask's result is the user's answer, read back as the reply that released the card and
                // settled the same way the fold settles one (card-status.ts). Text the formatter did not write
                // leaves the card unanswered rather than wearing a decision.
                const question = asked.get(block.tool_use_id);
                const reply = question === undefined ? undefined : parseAnswers(question.questions, block.tool_use_id, resultText(block.content));
                if (question !== undefined && reply !== undefined) {
                    Object.assign(question, settledCards({ question }, reply).question);
                }
            }
            // A user message carrying only tool_results is the SDK's plumbing, not something the user said.
            // Neither is an injected turn preamble or the trailing attachment note, the stored prompt
            // carries them, the redrawn bubble must not: the note's paths become attachment chips again
            // (workspace-relative, the shape the client uploads and fetches previews by; the turn resolved
            // them against the main root even for worktree turns, so `dir`, always the root here, is the
            // right base). An attachment-only message strips to empty text but still redraws its chips.
            if (text.length === 0) {
                continue;
            }
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
                if (block.name === "TaskCreate" || block.name === "TaskList" || block.name === "TaskUpdate") {
                    checklistCall(block.id, block.name, block.input);
                    continue;
                }
                /* The ask tool's call is where the live stream raised its `question` card, one frame ahead of the
                 * call itself, so the card goes down first and takes the open bubble with it, exactly as the fold
                 * of a recorded turn places it: the prose that led up to the ask stays above the card, and the
                 * call lands in the row beneath. A call whose input is not the ask's shape is an ordinary card. */
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
