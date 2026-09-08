import { sdk } from "../runtimes/claude/claude-sdk.js";
import type { MatchSnippet, TranscriptRow, Speaker } from "@intentic/sandbox-contract";
import { stripAttachmentNote } from "../agent/prompt/attachment-note.js";
import { parseRuntimeHistory } from "../agent/providers/runtime-history.js";
import { stripTurnPreamble } from "../agent/prompt/turn-preamble.js";

// Only spoken text, a side's own words, not tool calls, tool output, or protocol wrapping (preambles, attachment
// notes), is what the fleet filter and history search match on. The durable extraction lives in search-index.ts; this
// module holds just the write-lag overlay: prompts routed since boot, unioned into a search rather than replacing the
// index.

// One thing said, whole, before any windowing; the same pair `MatchSnippet` carries.
export interface SpokenLine {
    readonly text: string;
    readonly speaker: Speaker;
}

// sessionId → prompts routed into that session since boot, oldest dropped past ROUTED_PER_SESSION.
const routed = new Map<string, SpokenLine[]>();
// conversationId → prompts routed since boot; survives provider and runtime switches, unlike `routed`.
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

// Counters for the periodic resource series; covers only the write-lag overlay, not the durable index.
export const transcriptSearchMetrics = (): Readonly<Record<string, number>> => ({
    routedSessions: routed.size,
    routedLines: routedTotals.lines,
    routedTextCharacters: routedTotals.textCharacters,
    routedConversations: conversations.size,
    conversationLines: conversationTotals.lines,
    conversationTextCharacters: conversationTotals.textCharacters,
});

// Whitespace is collapsed once here rather than per query, so the durable index and this overlay window a hit the same
// way. Text is copied out of its parent, never sliced, so a stored line doesn't pin the whole original message in
// memory.
const spoken = (text: string, speaker: Speaker): SpokenLine[] => {
    const collapsed = text.replace(/\s+/gu, " ").trim();
    if (collapsed.length === 0) {
        return [];
    }
    return [{ text: Buffer.from(collapsed, "utf8").toString("utf8"), speaker }];
};

// A stored user message, cleaned of daemon protocol. Unfolds a runtime handoff's embedded history into its own
// user/agent lines rather than leaving it as one opaque block.
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

// A prompt being routed to a session right now, searchable immediately, whether or not the transcript has flushed yet.
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

// Extraction that fills the durable index (search-index.ts). A `notice` row, thinking, and tool cards are not speech;
// only text survives.
export const spokenLinesOf = (messages: readonly TranscriptRow[]): SpokenLine[] =>
    messages.flatMap((message) => {
        if (message.role === "user") {
            return userMessageLines(message.text);
        }
        return message.role === "assistant" ? spoken(message.text, "agent") : [];
    });

// Provider-neutral input for the fleet filter: the durable transcript's lines plus prompts routed but not yet appended
// to it.
export const conversationLines = (conversationId: string, recorded: readonly SpokenLine[]): readonly SpokenLine[] => [
    ...recorded,
    ...(conversations.get(conversationId) ?? []),
];

// A stored turn's `message` field is an Anthropic message: a bare string, or a block array whose text blocks carry the
// prose. `tool_result`, `tool_use`, and `thinking` blocks are not speech.
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

// Reads a session's transcript directly, uncached: the SDK's files run to tens of MB against a few KB of text. Falls
// back to an all-projects search by id when `dir`'s worktree no longer resolves. Called by the backfill, not per
// search.
export const readSessionLines = async (dir: string, sessionId: string): Promise<readonly SpokenLine[]> => {
    const scoped = await sdk().getSessionMessages(sessionId, { dir });
    const messages = scoped.length > 0 ? scoped : await sdk().getSessionMessages(sessionId);
    return storedLines(messages);
};

// Write-lag overlay for a runtime session, the counterpart of `conversationLines` on the fleet side.
export const sessionOverlay = (sessionId: string): readonly SpokenLine[] => routed.get(sessionId) ?? [];

// Snippet window width; must match search-index.ts's or a hit gets a different cut depending on which found it.
const SNIPPET_CHARS = 120;

const windowed = (line: SpokenLine, needle: string, caseSensitive: boolean): MatchSnippet | undefined => {
    // Already collapsed by `spoken` at construction; nothing to normalize here.
    const text = line.text;
    const at = (caseSensitive ? text : text.toLowerCase()).indexOf(needle);
    if (at === -1) {
        return undefined;
    }
    if (text.length <= SNIPPET_CHARS) {
        return { text, speaker: line.speaker };
    }
    // Centres on the hit, then clamps to the ends, so an edge hit keeps context on the side with room.
    const centred = Math.round(at + needle.length / 2 - SNIPPET_CHARS / 2);
    const start = Math.max(0, Math.min(text.length - SNIPPET_CHARS, centred));
    const end = start + SNIPPET_CHARS;
    return { text: `${start > 0 ? "…" : ""}${text.slice(start, end)}${end < text.length ? "…" : ""}`, speaker: line.speaker };
};

// Evidence for a filtered card: the matched line windowed around the hit. Runs only over the write-lag overlay, not the
// durable index; the user's own words win over the agent's when both match.
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
