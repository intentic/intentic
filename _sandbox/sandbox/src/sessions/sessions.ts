import { cachedAsync } from "@intentic/base/held";
import { sdk } from "../engines/claude-sdk.js";
import { AskQuestionSchema, type TodoItem } from "@intentic/sandbox-contract/events/requests";
import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import type { MatchSnippet } from "@intentic/sandbox-contract/schemas/agent-search";
import type { TranscriptQuestion, TranscriptRow } from "@intentic/sandbox-contract/events/transcript";
import { resumeNoticeRow } from "@intentic/sandbox-contract/events/resume";
import { unspokenPromptRow } from "@intentic/sandbox-contract/events/agent-words";
import { z } from "zod";
import { foldTurn } from "@intentic/sandbox-contract/transcript-fold";
import { ASK_TOOL_NAMES, parseAnswers } from "./vocabulary/question-answers.js";
import { TaskChecklist } from "./vocabulary/task-checklist.js";
import { resultText } from "./vocabulary/tool-calls.js";
import { SdkCallFrames } from "./vocabulary/sdk-call-frames.js";
import { browserOutputDir } from "../browser/cast/browser-artifacts.js";
import { rootRelative } from "./turn-transcript.js";
import type { SearchIndex } from "./search-index.js";
import { matchLines, sessionOverlay } from "./transcript-search.js";
import { flatSpokenWords, parsePromptEnvelope, storedPromptTitle } from "./vocabulary/prompt-envelope.js";

// The index's own search, passed in rather than imported, since this module knows how to ask what a session said, not
// where the index lives.
type SaidLookup = SearchIndex["search"];

// A past conversation for the chat-history list. `title` is what the user asked, never the daemon's notes (see
// listWorkspaceSessions); `updatedAt` is last-modified ms; `snippet` is set only by a search, and only when the title
// doesn't already show the hit.
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

// Sessions are the SDK's per-dir history menu, not fleet board conversations. A row is titled by the daemon's own record
// of the conversation it is the session of, else by the title the session was opened with, else by its first prompt
// with the daemon's injections stripped; an attachment-only opener titles by what was dropped in.
//
// The first prompt is the SDK's flattened copy (storedPromptTitle, flatSpokenWords), and a preamble longer than its
// 200-character cut leaves none of the user's words in it at all: that row is read back from its opening message once,
// and kept, since a session's first message never changes.
export interface SessionNaming {
    // Session id to the title of the conversation it is the current session of, renames and the naming pass included.
    readonly conversationTitles: () => ReadonlyMap<string, string>;
    // Opening titles already read back from session files, by session id.
    readonly openings: Map<string, string | undefined>;
}

export const sessionNaming = (conversationTitles: () => ReadonlyMap<string, string> = () => new Map()): SessionNaming => ({
    conversationTitles,
    openings: new Map(),
});

// A prompt that kept its newlines is a stored one, read whole; the SDK's list never keeps any.
const firstPromptTitle = (firstPrompt: string): string | undefined =>
    firstPrompt.includes("\n") ? storedPromptTitle(firstPrompt) : flatSpokenWords(firstPrompt);

// The session's first user message as stored, newlines and all; undefined when the file holds none or cannot be read.
const openingTitle = async (dir: string, id: string, openings: SessionNaming["openings"]): Promise<string | undefined> => {
    if (openings.has(id)) {
        return openings.get(id);
    }
    try {
        const opening = (await sdk().getSessionMessages(id, { dir, limit: 4 })).find((message) => message.type === "user");
        const text =
            opening === undefined
                ? ""
                : blocksOf(opening)
                      .flatMap((block) => (block.type === "text" && block.text !== undefined ? [block.text] : []))
                      .join("\n\n");
        const title = text === "" ? undefined : storedPromptTitle(text);
        openings.set(id, title);
        return title;
    } catch {
        // allow(silent-catch): an unreadable session keeps the fallback title, and the next listing tries again.
        return undefined;
    }
};

// What the session's own prompts name it: its first one, read back from the file when the list's copy holds only notes.
// `summary` is never nullish: the SDK fills it from the raw prompt (notice and runtime wrapper included) when it has no
// title, and with "" for a session row it could not read.
const promptedTitle = async (
    dir: string,
    session: { readonly sessionId: string; readonly firstPrompt?: string; readonly summary: string },
    openings: SessionNaming["openings"],
): Promise<string | undefined> => {
    if (session.firstPrompt !== undefined) {
        const first = firstPromptTitle(session.firstPrompt) ?? (await openingTitle(dir, session.sessionId, openings));
        if (first !== undefined) {
            return first;
        }
    }
    return session.summary === "" ? undefined : firstPromptTitle(session.summary);
};

export const listWorkspaceSessions = async (dir: string, naming: SessionNaming = sessionNaming()): Promise<SessionSummary[]> => {
    const sessions = await sdk().listSessions({ dir, limit: 50 });
    const named = naming.conversationTitles();
    return Promise.all(
        sessions.map(async (session) => ({
            id: session.sessionId,
            title: named.get(session.sessionId) ?? session.customTitle ?? (await promptedTitle(dir, session, naming.openings)) ?? "New chat",
            updatedAt: session.lastModified,
        })),
    );
};

// A short-TTL cache over the session list, so a burst of keystrokes shares one listing; never invalidated, since
// staying wrong that briefly is invisible. A factory, not a module-level cache, so callers (and tests) don't share
// hidden state.
export type RecentSessions = () => Promise<SessionSummary[]>;

const LIST_TTL_MS = 400;

export const createRecentSessions = (dir: string, naming: SessionNaming = sessionNaming()): RecentSessions => {
    const listed = cachedAsync<undefined, SessionSummary[]>({ ttlMs: LIST_TTL_MS });
    return async () => listed.get(undefined, async () => listWorkspaceSessions(dir, naming));
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

// One subagent the Claude runtime ran inside a session, from the record the store keeps beside that session and writes
// as the subagent works, by the same reducer; `dir` is the root attachment chips resolve against. Searched across every
// project, since the turn's working dir is not kept with the subagent. Empty when the store holds nothing for it.
export const readSubagentSession = async (dir: string, sessionId: string, agentId: string): Promise<TranscriptRow[]> => {
    try {
        return restoredSessionMessages(await sdk().getSubagentMessages(sessionId, agentId), dir);
    } catch {
        // allow(silent-catch): an unreadable store answers as one holding nothing; the caller falls back to the card's calls.
        return [];
    }
};

// Epoch ms the store stamped a message with, NaN when it carries none; the SDK's declared message type omits the field.
const storedAt = (message: object): number => {
    const { timestamp } = message as { readonly timestamp?: unknown };
    return typeof timestamp === "string" ? Date.parse(timestamp) : Number.NaN;
};

// The turn that began at `since` (epoch ms) alone, restored by the same reducer, for a turn the daemon died under and
// never reached the durable record. Empty when the store holds nothing from it, never an earlier turn in its place.
export const readWorkspaceSessionTail = async (dir: string, id: string, since: number): Promise<TranscriptRow[]> => {
    const scoped = await sdk().getSessionMessages(id, { dir });
    const messages = scoped.length > 0 ? scoped : await sdk().getSessionMessages(id);
    // A user message mid-turn (a steer, a task notification) is no boundary: the turn opens where the daemon started it.
    const start = messages.findIndex((message) => storedAt(message) >= since);
    // The tail is appended to the daemon's record, which already holds any history a handoff envelope carried.
    return start < 0 ? [] : restoredSessionMessages(messages.slice(start), dir, { carried: "dropped" });
};

// What a handoff envelope's folded-in transcript (runtime-history.ts) restores as: its own bubbles when the session is
// read on its own, nothing when the rows are appended to the daemon's record, which holds them already.
export interface RestoreOptions {
    readonly carried: "bubbles" | "dropped";
}

// A prompt nobody typed is its own row, never the user's bubble; `dir` is the root attachment chips resolve against.
const storedPromptRows = (text: string, dir: string, options: RestoreOptions): TranscriptRow[] => {
    // Read as the daemon's own record reads it (turn-transcript.ts).
    const unspoken = unspokenPromptRow(text);
    if (unspoken !== undefined) {
        return [unspoken];
    }
    const envelope = parsePromptEnvelope(text);
    // A re-run's resumed prompt becomes a muted line, not a duplicate; its note rides separately on the card.
    const resume = envelope.resume;
    if (resume?.kind === "notice") {
        return [resumeNoticeRow(resume)];
    }
    const attachments = rootRelative(envelope.attachments, dir);
    // The stripped preamble rides along as a note, read the same way the daemon's own record keeps it.
    const notes = [...envelope.notes, ...(resume?.kind === "note" ? [resume.note] : [])];
    const chips = attachments.length > 0 ? { attachments } : {};
    const said = envelope.spoken.length > 0 || attachments.length > 0;
    const handoff = envelope.handoff;
    if (handoff === undefined) {
        return said ? [{ role: "user", text: envelope.spoken, ...chips, ...(notes.length > 0 ? { notes } : {}) }] : [];
    }
    const carried: TranscriptRow[] = options.carried === "bubbles" ? [...handoff.history] : [];
    // A re-run sent to a fresh session carries its note inside the handoff: the same notice the record shows (`openingRows`).
    if (handoff.resume?.kind === "notice") {
        return [...carried, resumeNoticeRow(handoff.resume)];
    }
    const all = handoff.resume === undefined ? notes : [...notes, handoff.resume.note];
    return said ? [...carried, { role: "user", text: envelope.spoken, ...chips, ...(all.length > 0 ? { notes: all } : {}) }] : carried;
};

// A background task's report, stored as a user message; the live stream shows it on the task's own card, never as words.
const TaskNotification = z.object({ origin: z.object({ kind: z.literal("task-notification") }) });
// The CLI's summary opening a compacted chain, stored as a user message; the live stream draws a compaction notice.
const CompactSummary = z.object({ isCompactSummary: z.literal(true) });

// What the store kept of each turn it ran: the rows its prompt reads as, then the frames the live stream would have sent
// for what came after (no clock, no deltas: a stored block is whole).
interface StoredTurn {
    readonly opening: TranscriptRow[];
    readonly frames: AgentEvent[];
}

/* A STORED SESSION READ BACK THROUGH THE ONE FOLD. The provider's store keeps whole messages, not frames, so they are
   turned back into the frames the live stream sends for them (sdk-stream.ts, through the same SdkCallFrames for every
   card) and folded by the fold the live run and the record use (transcript-fold.ts). Grouping is the fold's alone: which
   bubble a thought, a run of calls or a card lands in is decided in one place, so a turn read back from here is grouped
   as it was drawn live. Each prompt opens a turn of its own, and each turn ends as a settled one does: a card nobody
   answered is frozen. Shared with a subagent's transcript and the tail of a turn the daemon died under. */
export const restoredSessionMessages = (
    messages: readonly { readonly type?: string; readonly message?: unknown }[],
    dir: string,
    options: RestoreOptions = { carried: "bubbles" },
): TranscriptRow[] => storedTurns(messages, dir, options).flatMap((turn) => foldTurn(turn.opening, turn.frames));

const storedTurns = (messages: readonly { readonly type?: string; readonly message?: unknown }[], dir: string, options: RestoreOptions): StoredTurn[] => {
    const turns: StoredTurn[] = [];
    // Frames before any prompt (a tail cut mid-turn, a subagent's record) open on no rows.
    const frames = (): AgentEvent[] => {
        const open = turns.at(-1) ?? { opening: [], frames: [] };
        if (turns.length === 0) {
            turns.push(open);
        }
        return open.frames;
    };
    const calls = new SdkCallFrames(dir, browserOutputDir(dir));
    // The working checklist reassembled from the Task tool family, as the live stream reassembles it.
    const checklist = new TaskChecklist();
    const checklistToolIds = new Set<string>();
    // tool_use id to the questions its ask asked, read against the answer its result carries.
    const asked = new Map<string, TranscriptQuestion["questions"]>();
    const todos = (items: TodoItem[] | undefined): AgentEvent[] => (items === undefined ? [] : [{ kind: "todos", items }]);

    const answered = (block: StoredBlock & { readonly tool_use_id: string }): AgentEvent[] => {
        if (checklistToolIds.delete(block.tool_use_id)) {
            const content = resultText(block.content);
            return todos(checklist.resolved(block.tool_use_id, content) ?? checklist.listed(content));
        }
        const result = calls.result({ id: block.tool_use_id, content: block.content, failed: block.is_error === true });
        const questions = asked.get(block.tool_use_id);
        // Unparsed text leaves the card unanswered, not wearing a decision.
        const reply = questions === undefined ? undefined : parseAnswers(questions, block.tool_use_id, resultText(block.content));
        if (reply === undefined) {
            return [result];
        }
        // The answer names its files absolute; the card shows them as the composer does, root-relative.
        const attachments =
            reply.attachments === undefined ? undefined : Object.fromEntries(Object.entries(reply.attachments).map(([question, paths]) => [question, rootRelative(paths, dir)]));
        return [result, { kind: "resolved", requestId: block.tool_use_id, reply: attachments === undefined ? reply : { ...reply, attachments } }];
    };

    const said = (block: StoredBlock): AgentEvent[] => {
        if (block.type === "text" && typeof block.text === "string") {
            return block.text.length === 0 ? [] : [{ kind: "delta", text: block.text }, { kind: "text_end" }];
        }
        if (block.type === "thinking" && typeof block.thinking === "string") {
            return [{ kind: "thinking", text: block.thinking }];
        }
        if (block.type !== "tool_use" || typeof block.id !== "string" || typeof block.name !== "string") {
            return [];
        }
        if (block.name === "TaskCreate" || block.name === "TaskList" || block.name === "TaskUpdate") {
            checklistToolIds.add(block.id);
            if (block.name === "TaskCreate") {
                checklist.created(block.id, block.input);
            }
            return block.name === "TaskUpdate" ? todos(checklist.updated(block.input)) : [];
        }
        // The store never saw the live question frame: the ask's call carries the questions, and its card lands one frame
        // ahead of the call, as it does live.
        const ask = ASK_TOOL_NAMES.has(block.name) ? AskInputSchema.safeParse(block.input) : undefined;
        const question: AgentEvent[] = ask?.success === true ? [{ kind: "question", requestId: block.id, questions: ask.data.questions }] : [];
        if (ask?.success === true) {
            asked.set(block.id, ask.data.questions);
        }
        return [...question, calls.call({ id: block.id, name: block.name, input: block.input })];
    };

    for (const message of messages) {
        if (message.type !== "user" && message.type !== "assistant") {
            continue;
        }
        const blocks = blocksOf(message);
        if (message.type === "assistant") {
            frames().push(...blocks.flatMap(said));
            continue;
        }
        if (CompactSummary.safeParse(message).success) {
            frames().push({ kind: "compact", trigger: "stored" });
            continue;
        }
        frames().push(...blocks.flatMap((block) => (block.type === "tool_result" && block.tool_use_id !== undefined ? answered({ ...block, tool_use_id: block.tool_use_id }) : [])));
        const text = blocks.flatMap((block) => (block.type === "text" && typeof block.text === "string" ? [block.text] : [])).join("");
        // Tool-results-only and injected notes aren't user words; real words open the next turn.
        if (text.length > 0 && !TaskNotification.safeParse(message).success) {
            turns.push({ opening: storedPromptRows(text, dir, options), frames: [] });
        }
    }
    return turns;
};
