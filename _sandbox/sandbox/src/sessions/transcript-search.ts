import { getSessionMessages } from "@anthropic-ai/claude-agent-sdk";
import type { MatchSnippet, RestoredMessage, Speaker } from "@intentic/sandbox-contract";
import { stripAttachmentNote } from "../agent/attachment-note.js";
import { parseRuntimeHistory } from "../agent/runtime-history.js";
import { stripTurnPreamble } from "../agent/turn-preamble.js";

/* What was SAID in a session, per side, the text the fleet filter and the history search match on.
 *
 * The board's filter answers "which chat was the one about X". Both halves of a conversation carry that: the
 * user's own prompts are what they remember opening with, and the agent's replies are where the answer they
 * are trying to find their way back to actually is, the name it found, the file it named, the number it
 * reported. Matching prompts alone sent people back to opening chats one at a time to re-read them.
 *
 * WHAT IS NOT SPEECH STAYS OUT, and that is the line that keeps a filter a filter: extended thinking, tool
 * calls and their output, and the daemon's own protocol (turn preambles, attachment notes). Tool output alone
 * names nearly every identifier in the workspace, so a transcript-WIDE match returns most of the board. Prose
 * is a small fraction of a transcript and reads like a sentence a person wrote, which is exactly why it can be
 * searched when a diff dump cannot.
 *
 * It is also why this is NOT readWorkspaceSession. That rebuilds the transcript a reopened tab redraws, tool
 * cards, call-time diffs, result settling, all of which a substring test throws away. Here each message is
 * reduced to its text, a few KB per session against the megabytes the full rebuild carries.
 *
 * THIS MODULE NO LONGER HOLDS AN INDEX. It extracts, and sessions/search-index.ts keeps what it extracted, on
 * disk, written forward as turns settle. The extraction used to be cached in this process instead: 24 MB of
 * heap for 1254 conversations, built on the query path, which made the first phrase search after a boot read
 * every transcript in the workspace. See search-index.ts for what that cost and what replaced it.
 *
 * What stays here is the WRITE-LAG OVERLAY, and it is the case that matters most: the prompt you JUST sent.
 * The durable record is written when a turn SETTLES, so between the send and the settle the index cannot know
 * about the words the user is most likely to search for, and a long turn holds that window open for minutes.
 * So the daemon records every prompt it routes (`recordPrompt`, from the turn's begin and from mid-turn
 * steering) into a small in-memory list that a search UNIONS with the index rather than replacing it. It is
 * bounded per conversation and only holds conversations touched since boot, so scanning it is free. The REPLY a
 * live turn is streaming needs no such record: the browser matches the tab it is holding open without asking
 * anyone (useAgentFilter), and the index grows the moment the turn settles.
 */

// One thing someone said, whole, a prompt or a chat bubble, before any windowing. The same pair the wire's
// MatchSnippet carries, because a snippet IS one of these cut down to the line around the hit.
export interface SpokenLine {
    readonly text: string;
    readonly speaker: Speaker;
}

// sessionId → the prompts this daemon routed into that session since it started. Bounded per session because
// a long-lived conversation is otherwise unbounded, and the oldest lines are the ones the record already has.
const routed = new Map<string, SpokenLine[]>();
// conversationId → prompts routed since boot. Unlike the session-keyed map above, this survives provider and
// runtime switches and is therefore what the unified fleet search joins against while a turn is still live.
const conversations = new Map<string, SpokenLine[]>();
const ROUTED_PER_SESSION = 200;

interface LineTotals {
    lines: number;
    textCharacters: number;
}

const routedTotals: LineTotals = { lines: 0, textCharacters: 0 };
const conversationTotals: LineTotals = { lines: 0, textCharacters: 0 };

const textCharacters = (lines: readonly SpokenLine[]): number => lines.reduce((total, line) => total + line.text.length, 0);

const replaceLines = (target: Map<string, SpokenLine[]>, key: string, lines: SpokenLine[], totals: LineTotals): void => {
    const previous = target.get(key);
    totals.lines += lines.length - (previous?.length ?? 0);
    totals.textCharacters += textCharacters(lines) - textCharacters(previous ?? []);
    target.set(key, lines);
};

// Cheap ownership counters for the periodic resource series, the write-lag overlay only: what the daemon has
// routed but not yet recorded. Everything else it can search lives on disk (see search-index.ts).
export const transcriptSearchMetrics = (): Readonly<Record<string, number>> => ({
    routedSessions: routed.size,
    routedLines: routedTotals.lines,
    routedTextCharacters: routedTotals.textCharacters,
    routedConversations: conversations.size,
    conversationLines: conversationTotals.lines,
    conversationTextCharacters: conversationTotals.textCharacters,
});

/* One line, NORMALIZED ONCE, here, at the single point where a line is constructed.
 *
 * Whitespace is collapsed at ingest rather than per query. A message is usually several lines and a snippet
 * that kept them would push every other card down the lane, so the collapse has to happen somewhere; doing it
 * on the query path meant a regex and a fresh allocation per line per keystroke over the whole fleet (~100 ms
 * of event-loop time per settled keystroke, on data that cannot change). Collapsing here also makes the
 * durable index and the in-memory overlay agree character for character, which is what lets a search union
 * them without one of them windowing a hit differently from the other.
 *
 * Copied out of its parent, never sliced from it: the strip/parse steps above answer with V8 slices, views
 * that pin the WHOLE original message (a prompt with its preamble and history envelope runs to hundreds of KB)
 * for as long as one line lives. Same mechanics as git/changes.ts materializedPaths.
 */
const spoken = (text: string, speaker: Speaker): SpokenLine[] => {
    const collapsed = text.replace(/\s+/gu, " ").trim();
    if (collapsed.length === 0) {
        return [];
    }
    return [{ text: Buffer.from(collapsed, "utf8").toString("utf8"), speaker }];
};

/* A stored USER message, cleaned of daemon protocol. A runtime handoff carries the earlier conversation inside
 * one SDK user message; unfold it so the replacement session stays searchable by everything that was said
 * before the switch, each side under its own speaker, while the handoff's own labels stay out.
 */
const userMessageLines = (text: string): SpokenLine[] => {
    const stripped = stripAttachmentNote(stripTurnPreamble(text)).text;
    const runtime = parseRuntimeHistory(stripped);
    if (runtime === undefined) {
        return spoken(stripped, "user");
    }
    return [
        ...runtime.history.flatMap((message) => spoken(message.text, message.role === "user" ? "user" : "agent")),
        ...spoken(runtime.prompt, "user"),
    ];
};

// A prompt the daemon is routing to a session right now, a turn's own prompt, or a message steered into a
// running one. Searchable from this moment, whether or not the transcript has been flushed.
export const recordPrompt = (sessionId: string, prompt: string): void => {
    const lines = userMessageLines(prompt);
    if (lines.length === 0) {
        return;
    }
    const held = [...(routed.get(sessionId) ?? []), ...lines].slice(-ROUTED_PER_SESSION);
    replaceLines(routed, sessionId, held, routedTotals);
};

export const recordConversationPrompt = (conversationId: string, prompt: string): void => {
    const lines = userMessageLines(prompt);
    if (lines.length === 0) {
        return;
    }
    const held = [...(conversations.get(conversationId) ?? []), ...lines].slice(-ROUTED_PER_SESSION);
    replaceLines(conversations, conversationId, held, conversationTotals);
};

// What was said in a restored transcript, the extraction the index is filled from (search-index.ts), for a
// conversation's record and for one settling turn alike. A `notice` row is neither side speaking (it is
// something that HAPPENED to the turn), and a message's thinking and tool cards are not speech, so only the
// text survives.
export const spokenLinesOf = (messages: readonly RestoredMessage[]): SpokenLine[] =>
    messages.flatMap((message) => {
        if (message.role === "user") {
            return userMessageLines(message.text);
        }
        return message.role === "assistant" ? spoken(message.text, "agent") : [];
    });

// Provider-neutral input for the fleet filter: the durable transcript's lines plus prompts routed by this
// process but not yet appended to that transcript.
export const conversationLines = (conversationId: string, recorded: readonly SpokenLine[]): readonly SpokenLine[] => [
    ...recorded,
    ...(conversations.get(conversationId) ?? []),
];

/* The `message` field of a stored turn is an Anthropic message: a bare string for a plain user prompt, or a
 * block array whose text blocks carry the prose. Everything else is not speech and never enters the index,
 * `tool_result` blocks on a user message, `tool_use` and `thinking` blocks on an assistant one, all of it the
 * SDK's plumbing between turns rather than something either side said.
 */
interface StoredMessage {
    content?: string | { type?: string; text?: string }[];
}

const storedLines = (messages: readonly { type: string; message?: unknown }[]): SpokenLine[] => {
    const out: SpokenLine[] = [];
    for (const message of messages) {
        if (message.type !== "user" && message.type !== "assistant") {
            continue;
        }
        const content = (message.message as StoredMessage | undefined)?.content;
        const text =
            typeof content === "string"
                ? content
                : (content ?? [])
                      .filter((block) => block.type === "text" && typeof block.text === "string")
                      .map((block) => block.text)
                      .join("");
        out.push(...(message.type === "user" ? userMessageLines(text) : spoken(text, "agent")));
    }
    return out;
};

/* What was said in this session, READ, not cached: the index is what remembers it (search-index.ts), and this
 * is the extraction that fills the index for a runtime session. `dir` scopes the SDK's lookup to this
 * workspace and its LIVE worktrees; an archived agent's transcript is keyed by a worktree path
 * `git worktree list` no longer names, so the all-projects search by id is the fallback that keeps the archive
 * searchable (the same two-step readWorkspaceSession makes, and ids are UUIDs so the widened search can only
 * find the one asked for).
 *
 * This is the expensive one and always was: the SDK's session files carry every tool call and result, so they
 * run to tens of megabytes each where the spoken text is a few KB. It is now called by the BACKFILL, off the
 * request path, once per session per change, rather than by a search.
 */
export const readSessionLines = async (dir: string, sessionId: string): Promise<readonly SpokenLine[]> => {
    const scoped = await getSessionMessages(sessionId, { dir });
    const messages = scoped.length > 0 ? scoped : await getSessionMessages(sessionId);
    return storedLines(messages);
};

// The write-lag overlay for a runtime session, the counterpart of `conversationLines` on the fleet side.
export const sessionOverlay = (sessionId: string): readonly SpokenLine[] => routed.get(sessionId) ?? [];

// How much of the matched line a card shows. Wide enough to carry the sentence the term sits in, short
// enough that the line never outgrows the card it explains. Must equal search-index.ts's own, or a snippet
// would be cut to a different width depending on which of the two found it.
const SNIPPET_CHARS = 120;

const windowed = (line: SpokenLine, needle: string, caseSensitive: boolean): MatchSnippet | undefined => {
    // Already collapsed, by `spoken`, at construction. Nothing to normalize here.
    const text = line.text;
    const at = (caseSensitive ? text : text.toLowerCase()).indexOf(needle);
    if (at === -1) {
        return undefined;
    }
    if (text.length <= SNIPPET_CHARS) {
        return { text, speaker: line.speaker };
    }
    // Centre the window on the hit, then clamp to the ends, a match near either edge keeps its full context
    // on the side that has room instead of padding an ellipsis that shows nothing.
    const centred = Math.round(at + needle.length / 2 - SNIPPET_CHARS / 2);
    const start = Math.max(0, Math.min(text.length - SNIPPET_CHARS, centred));
    const end = start + SNIPPET_CHARS;
    return { text: `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`, speaker: line.speaker };
};

/* The matched line, windowed around the hit, the EVIDENCE a filtered card shows. Without it a card matching
 * on message #7 is unexplained, and an unexplained result is what teaches people not to trust a search.
 *
 * SCOPE: this now runs over the WRITE-LAG OVERLAY only, the handful of prompts routed since boot that the
 * durable index cannot know about yet. The index answers the same question in SQL for everything else, by the
 * same two rules (see search-index.ts's query), because a search unions the two and one query must not come
 * back ranked two ways.
 *
 * THE USER'S OWN WORDS WIN when both sides match, which is why this is two passes rather than one. A query is
 * typed from memory, and what a person remembers is their own phrasing; the agent repeating the same term back
 * three turns later is the weaker evidence of the two even though it usually sits earlier in the scan.
 *
 * Returns undefined when nothing matched. `needle` arrives folded to the case rule the caller is searching under
 *, lowercased for the default, verbatim when the field's Aa switch is on, because a filter runs this over the
 * whole fleet on every keystroke, so the query is prepared once by the caller rather than per line here.
 */
export const matchLines = (lines: readonly SpokenLine[], needle: string, caseSensitive: boolean): MatchSnippet | undefined => {
    const said = (speaker: Speaker): MatchSnippet | undefined => {
        for (const line of lines) {
            const hit = line.speaker === speaker ? windowed(line, needle, caseSensitive) : undefined;
            if (hit !== undefined) {
                return hit;
            }
        }
        return undefined;
    };
    return said("user") ?? said("agent");
};
