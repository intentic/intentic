import { getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import type { RestoredMessage } from "@intentic/sandbox-contract";
import { stripAttachmentNote } from "../agent/attachment-note.js";
import { parseRuntimeHistory } from "../agent/runtime-history.js";
import { stripTurnPreamble } from "../agent/turn-preamble.js";

/* What the USER said, per session — the one thing the fleet filter matches on.
 *
 * The board's filter (and the popped-out rail's) answers "which agent did I ask about X". Their own prompts
 * are what people remember and what tells two agents apart; an agent's replies and its tool output name
 * nearly every identifier in the workspace, so matching those returns most of the board and the filter stops
 * filtering. So this reads exactly the user half of a transcript and nothing else.
 *
 * It is also why this is NOT readWorkspaceSession. That rebuilds the transcript a reopened tab redraws —
 * tool cards, call-time diffs, result settling — all of which the filter throws away. Here the assistant
 * messages are skipped entirely and the user ones are reduced to their text, which is a few KB per session
 * against the megabytes the full rebuild carries.
 *
 * CACHING is what makes searching the whole fleet affordable: one query scans every registered agent, live
 * and archived, and typing is a burst of queries. Prompts are immutable once written — a turn only ever
 * APPENDS one — so a session's file read stays valid for the life of the daemon.
 *
 * Which leaves exactly one hole, and it is the case that matters most: the prompt you JUST sent. The SDK
 * writes it as the turn starts, so a search landing in that window would read a transcript without it, cache
 * that, and go on missing it for as long as the turn runs. So the daemon records every prompt it routes
 * (`recordPrompt`, from the turn's begin and from mid-turn steering) into a second list that is unioned with
 * the file read rather than replacing it. A prompt that appears in both simply matches twice, which is free —
 * whereas the alternatives (mtime probes, TTLs, re-reading per keystroke) all buy the same correctness with
 * work on the query path.
 */

// sessionId → the user prompts read out of that session's stored transcript, oldest first.
const stored = new Map<string, string[]>();

// sessionId → the prompts this daemon routed into that session since it started. Unioned with `stored`, never
// invalidated by it. Bounded per session because a long-lived conversation is otherwise unbounded, and the
// oldest prompts are the ones the file read is certain to have.
const routed = new Map<string, string[]>();
// conversationId → prompts routed since boot. Unlike the session-keyed map above, this survives provider and
// runtime switches and is therefore what the unified fleet search joins against while a turn is still live.
const conversations = new Map<string, string[]>();
const ROUTED_PER_SESSION = 200;

// Stored prompts without daemon protocol. A runtime handoff carries earlier roles inside one SDK user message;
// unfold its USER half so the replacement session stays searchable by everything the person asked before the
// switch, while assistant prose and the handoff labels remain excluded.
const cleanPrompts = (text: string): string[] => {
    const stripped = stripAttachmentNote(stripTurnPreamble(text)).text;
    const runtime = parseRuntimeHistory(stripped);
    const prompts =
        runtime === undefined
            ? [stripped]
            : [...runtime.history.filter((message) => message.role === "user").map((message) => message.text), runtime.prompt];
    return prompts.map((prompt) => prompt.trim()).filter((prompt) => prompt.length > 0);
};

// A prompt the daemon is routing to a session right now — a turn's own prompt, or a message steered into a
// running one. Searchable from this moment, whether or not the transcript has been flushed.
export const recordPrompt = (sessionId: string, prompt: string): void => {
    const cleaned = cleanPrompts(prompt);
    if (cleaned.length === 0) {
        return;
    }
    const held = routed.get(sessionId) ?? [];
    held.push(...cleaned);
    routed.set(sessionId, held.slice(-ROUTED_PER_SESSION));
};

export const recordConversationPrompt = (conversationId: string, prompt: string): void => {
    const cleaned = cleanPrompts(prompt);
    if (cleaned.length === 0) {
        return;
    }
    const held = conversations.get(conversationId) ?? [];
    held.push(...cleaned);
    conversations.set(conversationId, held.slice(-ROUTED_PER_SESSION));
};

// What the USER said in a transcript, cleaned of daemon protocol — the extraction the fleet filter matches
// on, shared with the cached per-conversation read in agent-transcript.ts.
export const userPromptsOf = (messages: readonly RestoredMessage[]): string[] =>
    messages.filter((message) => message.role === "user").flatMap((message) => cleanPrompts(message.text));

// Provider-neutral prompt input for the fleet filter: the durable transcript's prompts plus prompts routed by
// this process but not yet appended to that transcript. Assistant prose and tool output never enter the list.
export const conversationPrompts = (conversationId: string, recorded: readonly string[]): readonly string[] => [
    ...recorded,
    ...(conversations.get(conversationId) ?? []),
];

// The `message` field of a stored turn is an Anthropic message: a bare string for a plain user prompt, or a
// block array whose text blocks carry the prose. Everything else on a user message (tool_result blocks) is
// the SDK's plumbing between assistant turns, not something the user said.
interface StoredUserMessage {
    content?: string | { type?: string; text?: string }[];
}

const promptsOf = (messages: readonly { type: string; message?: unknown }[]): string[] => {
    const out: string[] = [];
    for (const message of messages) {
        if (message.type !== "user") {
            continue;
        }
        const content = (message.message as StoredUserMessage | undefined)?.content;
        const text =
            typeof content === "string"
                ? content
                : (content ?? [])
                      .filter((block) => block.type === "text" && typeof block.text === "string")
                      .map((block) => block.text)
                      .join("");
        out.push(...cleanPrompts(text));
    }
    return out;
};

// This session's user prompts. `dir` scopes the SDK's lookup to this workspace and its LIVE worktrees; an
// archived agent's transcript is keyed by a worktree path `git worktree list` no longer names, so the
// all-projects search by id is the fallback that keeps the archive searchable (the same two-step
// readWorkspaceSession makes, and ids are UUIDs so the widened search can only find the one asked for).
export const readSessionPrompts = async (dir: string, sessionId: string): Promise<readonly string[]> => {
    const live = routed.get(sessionId) ?? [];
    const held = stored.get(sessionId);
    if (held !== undefined) {
        return live.length === 0 ? held : [...held, ...live];
    }
    const scoped = await getSessionMessages(sessionId, { dir });
    const messages = scoped.length > 0 ? scoped : await getSessionMessages(sessionId);
    const prompts = promptsOf(messages);
    stored.set(sessionId, prompts);
    return live.length === 0 ? prompts : [...prompts, ...live];
};

// How much of the matched prompt a card shows. Wide enough to carry the sentence the term sits in, short
// enough that the line never outgrows the card it explains.
const SNIPPET_CHARS = 120;

/* The matched prompt, windowed around the hit — the EVIDENCE a filtered card shows. Without it a card
 * matching on prompt #7 is unexplained, and an unexplained result is what teaches people not to trust a
 * search. Whitespace is collapsed first: a prompt is usually several lines, and a snippet that kept them
 * would push every other card down the lane.
 *
 * Returns undefined when nothing matched. `needle` arrives already lowercased — a filter runs this over the
 * whole fleet on every keystroke, so the query is folded once by the caller rather than per prompt here.
 */
export const matchPrompts = (prompts: readonly string[], needle: string): string | undefined => {
    for (const prompt of prompts) {
        const line = prompt.replace(/\s+/gu, " ").trim();
        const at = line.toLowerCase().indexOf(needle);
        if (at === -1) {
            continue;
        }
        if (line.length <= SNIPPET_CHARS) {
            return line;
        }
        // Centre the window on the hit, then clamp to the ends — a match near either edge keeps its full
        // context on the side that has room instead of padding an ellipsis that shows nothing.
        const centred = Math.round(at + needle.length / 2 - SNIPPET_CHARS / 2);
        const start = Math.max(0, Math.min(line.length - SNIPPET_CHARS, centred));
        const end = start + SNIPPET_CHARS;
        return `${start > 0 ? "…" : ""}${line.slice(start, end)}${end < line.length ? "…" : ""}`;
    }
    return undefined;
};
