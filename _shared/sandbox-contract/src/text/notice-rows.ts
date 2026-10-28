import type { AgentEvent } from "../events/agent-events.js";
import type { TranscriptRow } from "../events/transcript.js";
import { noticeCode, type SandboxNotice } from "../events/sandbox-notice.js";
import { contextTrimLine, contextTrimNotice } from "../schemas/context-trim.js";
import { freshStartLine, freshStartNotice, handedOffLine, handedOffNotice } from "../schemas/providers/handoff.js";
import { switchedLine, switchedNotice } from "../schemas/providers/switched.js";

// The notices that say what a turn was given to start from, each a row of its own worded from its frame's facts: what
// the window left out of the message, how a held turn continued, where a home's session started over, and what the
// turn switched to since the one before it.
type StartingFrame = Extract<AgentEvent, { kind: "context_trim" | "handoff" | "fresh_start" | "switched" }>;
const STARTING_KINDS: ReadonlySet<AgentEvent["kind"]> = new Set<StartingFrame["kind"]>(["context_trim", "handoff", "fresh_start", "switched"]);

/** Whether the frame is one of those notices. */
export const isStartingFrame = (event: AgentEvent): event is StartingFrame => STARTING_KINDS.has(event.kind);

/** A starting frame's row, in the English the record keeps, with the code a reader words it from. */
export const startingRow = (event: StartingFrame): TranscriptRow => {
    switch (event.kind) {
        case "context_trim":
            return { role: "notice", text: contextTrimLine(event), noticeCode: noticeCode(contextTrimNotice(event)) };
        case "handoff":
            return { role: "notice", text: handedOffLine(event), noticeCode: noticeCode(handedOffNotice(event)) };
        case "fresh_start":
            return { role: "notice", text: freshStartLine(event), noticeCode: noticeCode(freshStartNotice(event)) };
        case "switched":
            return { role: "notice", text: switchedLine(event), noticeCode: noticeCode(switchedNotice(event)) };
    }
};

/** A move off one account onto another before a turn ran, as its notice carries it. */
export type AccountMoved = Extract<SandboxNotice, { code: "accountMoved" }>["params"];

// Each names both accounts, since "moved" alone leaves the reader to work out from where and to where.
const MOVED_LINES = {
    refused: ({ from, to }) => `Ran on ${to}: the ${from} account's plan or organization does not allow it.`,
    reach: ({ from, to }) => `Ran on ${to}: the people this conversation works for may not use the ${from} account.`,
    cold: ({ from, to }) => `Moved from ${from} to ${to}, which has more room left: the cache had expired, so moving cost nothing.`,
} as const satisfies Readonly<Record<AccountMoved["why"], (move: AccountMoved) => string>>;

/** The row a turn moved to another account opens with, so the reader learns where it ran and why without asking. */
export const accountMovedRow = (move: AccountMoved): TranscriptRow => ({
    role: "notice",
    text: MOVED_LINES[move.why](move),
    noticeCode: noticeCode({ code: "accountMoved", params: move }),
});
