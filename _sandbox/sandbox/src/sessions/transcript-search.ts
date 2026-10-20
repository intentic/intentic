import { sdk } from "../engines/claude-sdk.js";
import type { MatchSnippet, Speaker } from "@intentic/sandbox-contract/schemas/agent-search";
import type { TranscriptRow, TranscriptTool } from "@intentic/sandbox-contract/events/transcript";
import { oneLine } from "@intentic/base/one-line";
import { parsePromptEnvelope } from "./vocabulary/prompt-envelope.js";

// Spoken text, a side's own words, never tool output or protocol wrapping (preambles, attachment notes), is what the
// fleet filter and history search match on. Beside it a conversation's record also yields what it DID, marked by `via`:
// each tool call's name and target, each question card it raised, each notice, each run. Only `agents find` asks for
// those (fleet-recall.ts): an agent hunting the conversation that ran `curl --unix-socket …front.sock` was told nobody
// said it, because only speech was indexed. The board's filter and the history box stay speech only. This module holds
// the extraction and the write-lag overlay: prompts routed since boot, unioned into a search rather than replacing the
// index.

// What a line that is not speech records: a tool call (its name and target), a question card the agent raised, a notice
// that happened to the turn, and the run a row came from, so a run id from a log line finds its conversation.
export type LineVia = "ran" | "asked" | "notice" | "run";

// One thing said or done, whole, before any windowing. `via` is absent for speech, the pair `MatchSnippet` carries.
export interface SpokenLine {
    readonly text: string;
    readonly speaker: Speaker;
    readonly via?: LineVia;
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

// A stored user message as its turn was queued, a re-run's note included; a runtime handoff's history unfolds into its own lines.
const userMessageLines = (text: string): SpokenLine[] => {
    const { queued, handoff } = parsePromptEnvelope(text);
    return [
        ...(handoff?.history ?? []).flatMap((message) => spoken(message.text, message.role === "user" ? "user" : "agent")),
        ...spoken(queued, "user"),
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

// A deed's line is its name and the start of its target: a command or a path is recognised by its opening, and a
// heredoc whole would make the index several times the size of everything said.
const DEED_CHARS = 160;

// Carried as the agent's, since a snippet names one of two sides; `via` is what says it was a deed, or the sandbox's.
const deed = (text: string, via: LineVia): SpokenLine[] => {
    return spoken(oneLine(text, DEED_CHARS), "agent").map((said) => ({ ...said, via }));
};

// A call's name with what it acted on, a delegation's own calls included; a call with no target (an MCP tool, a
// subagent) is found by its name, a subagent also by its one-line ask, and an MCP call by the opening of its input.
const toolLines = (tools: readonly TranscriptTool[]): SpokenLine[] =>
    tools.flatMap((tool) => [
        ...deed([tool.name, tool.target ?? tool.subagent?.description ?? tool.input ?? ""].join(" "), "ran"),
        ...toolLines(tool.children ?? []),
    ]);

// A question card as the agent asked it, with what was picked, one line a question.
const questionLines = (question: TranscriptRow["question"]): SpokenLine[] =>
    (question?.questions ?? []).flatMap((asked) => {
        const picks = question?.answers?.[asked.question] ?? [];
        return deed(picks.length === 0 ? asked.question : `${asked.question} → ${picks.join(", ")}`, "asked");
    });

// The deeds of these rows, each line once: the same file read twenty times is one line, not twenty.
const deedLinesOf = (messages: readonly TranscriptRow[]): SpokenLine[] => {
    const lines = messages.flatMap((message) => [
        ...(message.role === "notice" ? deed(message.text, "notice") : []),
        ...questionLines(message.question),
        ...toolLines(message.tools ?? []),
    ]);
    const runs = [...new Set(messages.flatMap((message) => (message.run === undefined ? [] : [message.run])))];
    const seen = new Set<string>();
    return [...lines, ...runs.flatMap((run) => deed(`run ${run}`, "run"))].filter((line) => {
        const key = `${line.via ?? ""}:${line.text}`;
        if (seen.has(key)) {
            return false;
        }
        seen.add(key);
        return true;
    });
};

// Extraction that fills the durable index (search-index.ts): what each side said, then what the conversation did.
// Thinking and tool output are neither.
export const spokenLinesOf = (messages: readonly TranscriptRow[]): SpokenLine[] => [
    ...messages.flatMap((message) => {
        if (message.role === "user") {
            return userMessageLines(message.text);
        }
        return message.role === "assistant" ? spoken(message.text, "agent") : [];
    }),
    ...deedLinesOf(messages),
];

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
