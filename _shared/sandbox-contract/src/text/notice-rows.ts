import type { AgentEvent } from "../events/agent-events.js";
import type { TranscriptRow } from "../events/transcript.js";
import { noticeCode, type SandboxNotice } from "../events/sandbox-notice.js";
import { contextTrimLine, contextTrimNotice } from "../schemas/context-trim.js";
import { freshStartLine, freshStartNotice, handedOffLine, handedOffNotice } from "../schemas/providers/handoff.js";
import { switchedLine, switchedNotice } from "../schemas/providers/switched.js";

// The notices that say what a turn was given to start from, each a row of its own worded from its frame's facts: what
// the window left out of the message, how a held turn continued, where a home's session started over, what the turn
// switched to since the one before it, and the copy of the workspace the sandbox had to set up again for it.
type StartingFrame = Extract<AgentEvent, { kind: "context_trim" | "handoff" | "fresh_start" | "switched" | "workspace_repaired" }>;
const STARTING_KINDS: ReadonlySet<AgentEvent["kind"]> = new Set<StartingFrame["kind"]>(["context_trim", "handoff", "fresh_start", "switched", "workspace_repaired"]);

// The sandbox's one repair of a conversation's view of the workspace, made before the model was asked anything.
const repairedLine = (layers: number): string =>
    layers === 0
        ? "This conversation's workspace copy failed to start, so it was rebuilt."
        : `Workspace copy rebuilt; ${String(layers)} dependency ${layers === 1 ? "layer" : "layers"} set aside, reinstall if needed.`;

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
        case "workspace_repaired":
            return { role: "notice", text: repairedLine(event.layers), noticeCode: noticeCode({ code: "workspaceRepaired", params: { layers: event.layers } }) };
    }
};

/** A move off one account onto another before a turn ran, as its notice carries it. */
export type AccountMoved = Extract<SandboxNotice, { code: "accountMoved" }>["params"];

// Each names both accounts, since "moved" alone leaves the reader to work out from where and to where.
const MOVED_LINES = {
    refused: ({ from, to }) => `Ran on ${to}: ${from}'s plan or organization doesn't allow it.`,
    // Says how to overrule it: the records can be wrong (a limit reset, a plan upgraded), and a pick of the account wins.
    spent: ({ from, to }) => `Ran on ${to}: ${from} looks used up; pick it in the composer to override.`,
    reach: ({ from, to }) => `Ran on ${to}: this conversation's people may not use ${from}.`,
    cold: ({ from, to }) => `Moved from ${from} to ${to}: more room, and the cache had expired.`,
} as const satisfies Readonly<Record<AccountMoved["why"], (move: AccountMoved) => string>>;

/** The row a turn moved to another account opens with, so the reader learns where it ran and why without asking. */
export const accountMovedRow = (move: AccountMoved): TranscriptRow => ({
    role: "notice",
    text: MOVED_LINES[move.why](move),
    noticeCode: noticeCode({ code: "accountMoved", params: move }),
});
