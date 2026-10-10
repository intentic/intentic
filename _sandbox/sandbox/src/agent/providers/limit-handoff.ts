import { tokensOfChars } from "@intentic/base/format";
import {
    type AgentTurn,
    capabilitiesOf,
    type HandedOff,
    type HandoffMode,
    type HandoffOffer,
    suggestHandoff,
    TRIM_KEEPS_RESULTS,
    type TranscriptRow,
    type TurnNote,
    withRuntimeDefaults,
} from "@intentic/sandbox-contract";
import type { Services } from "../../composition.js";
import { estimateCopy, readSessionChain, writeSessionCopy } from "../../runtimes/claude/claude-session-copy.js";
import type { AgentExecutionContext } from "../../workload/agent-execution.js";
import { askRoleModel, roleModelIsSet } from "../models/role-model.js";

/* HOW A HELD TURN CONTINUES ONCE ITS CACHE IS COLD (contract: schemas/providers/handoff.ts).

   A spent allowance holds a turn until the reset or a move to another account; either way the prompt cache is gone by
   then, and resuming the session re-reads all of it on every call of the next turn. Three ways on, and a person picks:
     carry    resume the session as it is
     trim     resume a copy with older tool output cleared (Claude Code sessions: claude-session-copy.ts)
     summary  a fresh session opened with a summary a smaller model wrote, beside the recent conversation and the
              sandbox's own "where the work stands" note
   Measured before it was built (sandbox/bench/handoff-bench.ts, 4 real cuts): carry 93% of probe questions right,
   trim 91% at a half to a third of the cost above ~200k, a Haiku summary 85%, and the short record hand-off alone 50%. */

// What a summary adds to a fresh session's opening, in tokens: measured summaries ran 3-6k.
const SUMMARY_TOKENS = 6_000;
// The part of a fresh session that is not the conversation (system prompt, tool definitions), where nothing measured it.
const FRESH_OVERHEAD_TOKENS = 20_000;

export interface OfferParams {
    readonly turn: AgentTurn & { readonly conversationId: string };
    readonly ran: boolean;
    readonly sessionId: string | undefined;
    readonly contextTokens: number | undefined;
    // The capped record plus the measured brief: what a fresh session opens with before any summary.
    readonly handoffTokens: number;
    readonly rows: readonly TranscriptRow[];
}

const runsClaudeCode = (turn: AgentTurn): boolean => {
    const { agent, harness } = withRuntimeDefaults(turn);
    return capabilitiesOf(agent, harness).runtime === "claude-code";
};

const sessionStoreOf = (services: Pick<Services, "agents" | "agentWorktrees">, conversationId: string): string =>
    services.agentWorktrees.sessionStore(services.agents.entry(conversationId));

// The ways a held turn can continue on its own runtime, the sizes each starts from, and the one the sandbox would use:
// the owner's standing setting where it names an available one, else the size-based suggestion. Undefined when there is
// nothing to choose between (the turn never ran, so no session holds anything worth carrying, and no summary is set).
export const handoffOfferOf = async (
    services: Services,
    params: OfferParams,
): Promise<HandoffOffer | undefined> => {
    if (!params.ran) {
        return undefined;
    }
    const settings = await services.sandboxSettings.get();
    const carries = params.sessionId !== undefined;
    const trim = carries && runsClaudeCode(params.turn) ? await trimEstimate(services, params) : undefined;
    const summary = (await roleModelIsSet(services, "handoff-summary"))
        ? {
              tokens: (trim?.overhead ?? FRESH_OVERHEAD_TOKENS) + params.handoffTokens + SUMMARY_TOKENS,
              reads: tokensOfChars(renderRecord(params.rows, Number.POSITIVE_INFINITY).length),
          }
        : undefined;
    const offered: Pick<HandoffOffer, HandoffMode> = {
        ...(carries ? { carry: params.contextTokens === undefined ? {} : { tokens: params.contextTokens } } : {}),
        ...(trim === undefined ? {} : { trim: { tokens: trim.tokens, cleared: trim.cleared } }),
        ...(summary === undefined ? {} : { summary }),
    };
    const available = (mode: HandoffMode): boolean => offered[mode] !== undefined;
    const named = settings.limitHandoff === "suggested" ? undefined : settings.limitHandoff;
    const suggested =
        named !== undefined && available(named)
            ? named
            : suggestHandoff(params.contextTokens, available, { carryUnder: settings.limitMoveCarryUnder, summaryOver: settings.handoffSummaryOver });
    if (suggested === undefined || Object.keys(offered).length < 2) {
        // One way on is no choice: the re-run takes it, as it always has.
        return undefined;
    }
    return { suggested, basis: named !== undefined && named === suggested ? "setting" : "size", ...offered };
};

// A trimmed copy's size, measured on the session file; undefined when the store does not hold it, or trimming would
// clear nothing (a short session: carrying it is the same thing).
const trimEstimate = async (
    services: Pick<Services, "agents" | "agentWorktrees" | "logger">,
    params: OfferParams,
): Promise<{ readonly tokens: number; readonly cleared: number; readonly overhead: number } | undefined> => {
    if (params.sessionId === undefined) {
        return undefined;
    }
    try {
        const read = await readSessionChain(sessionStoreOf(services, params.turn.conversationId), params.sessionId, true);
        const estimate = read === undefined ? undefined : estimateCopy(read.chain, params.contextTokens);
        return estimate === undefined || estimate.cleared === 0
            ? undefined
            : { tokens: estimate.trimTokens, cleared: estimate.cleared, overhead: estimate.overhead };
    } catch (error) {
        services.logger.warn({ err: error, conversationId: params.turn.conversationId }, "hand-off: could not measure a trimmed session");
        return undefined;
    }
};

/* ---------- trim: at the re-run, before the session is probed ---------- */

// Writes the trimmed copy and points the turn at it; on any failure the turn resumes the session whole, and says so.
export const trimmedTurn = async <T extends AgentTurn & { readonly sessionId?: string | undefined }>(
    services: Pick<Services, "agents" | "agentWorktrees" | "logger">,
    turn: T,
    held: { readonly contextTokens?: number | undefined } | undefined,
): Promise<{ readonly turn: T; readonly event: HandedOff }> => {
    const from = held?.contextTokens;
    if (turn.sessionId === undefined || turn.conversationId === undefined || !runsClaudeCode(turn)) {
        return { turn, event: { mode: "trim", fellBack: true } };
    }
    try {
        const copy = await writeSessionCopy(sessionStoreOf(services, turn.conversationId), turn.sessionId, {
            keep: TRIM_KEEPS_RESULTS,
            dropUnanswered: true,
        });
        if (copy === undefined) {
            return { turn, event: { mode: "trim", fellBack: true } };
        }
        const tokens = from === undefined || copy.fromChars === 0 ? undefined : Math.round((from * copy.chars) / copy.fromChars);
        return {
            turn: { ...turn, sessionId: copy.sessionId },
            event: { mode: "trim", cleared: copy.cleared, ...(tokens === undefined ? {} : { tokens }), ...(from === undefined ? {} : { from }) },
        };
    } catch (error) {
        services.logger.warn({ err: error, conversationId: turn.conversationId }, "hand-off: could not write a trimmed session, carrying it whole");
        return { turn, event: { mode: "trim", fellBack: true } };
    }
};

/* ---------- summary: at the re-run, once the fresh session's record is read ---------- */

export const SUMMARY_NOTE_TITLE = "Summary of the conversation so far";

const SUMMARY_INSTRUCTIONS = `You are writing the hand-off for a coding session that ran out of usage allowance. A new session, with none of this conversation in its context, will continue the work from your summary, the last part of the conversation and a note of what the sandbox measured (files changed, checks, the checklist). It can read the repository, so file contents need not be copied; what it cannot recover is what was said, decided, tried and learned.

Write these sections, dense and specific (exact paths, commands, names, numbers, error messages):
1. The user's requests and intent: every explicit ask and constraint, in the user's own words where they matter, including corrections and preferences.
2. Decisions and their reasons, and approaches tried and abandoned (with why).
3. Files and code: which files were read, created or changed, and what about them matters.
4. Errors met and how they were fixed; tests and checks run and their last result.
5. Pending tasks: everything asked for and not yet done.
6. Current work: precisely what was being done right before the cut, and the next step, quoting the latest instruction verbatim.

Output only the summary.`;

const RESULT_CAP = 1_500;
// Of a transcript too long for the summarising model, the share kept from its start: the first requests set the task.
const HEAD_SHARE = 0.15;

const capped = (text: string, limit: number): string => (text.length > limit ? `${text.slice(0, limit)}… [${text.length - limit} more chars]` : text);

const toolText = (tool: NonNullable<TranscriptRow["tools"]>[number]): string => {
    const output = (tool.content ?? [])
        .map((part) => (part.type === "text" ? part.text : ""))
        .filter((text) => text !== "")
        .join("\n");
    return `→ ${tool.name}${tool.target === undefined ? "" : ` ${tool.target}`}${tool.status === "failed" ? " (failed)" : ""}${output === "" ? "" : `\n${capped(output, RESULT_CAP)}`}`;
};

// The conversation as the summarising model reads it: who said what, which tools ran on what, and what they returned,
// capped. Past `room` characters, its opening and its newest part, which matter most to a continuation.
export const renderRecord = (rows: readonly TranscriptRow[], room: number): string => {
    const parts: string[] = [];
    for (const row of rows) {
        if (row.role === "user" && row.text !== "") {
            parts.push(`\n### USER\n${row.text}`);
        } else if (row.role === "assistant") {
            if (row.text !== "") {
                parts.push(`ASSISTANT: ${row.text}`);
            }
            for (const tool of row.tools ?? []) {
                parts.push(toolText(tool));
            }
        }
    }
    const text = parts.join("\n");
    if (text.length <= room) {
        return text;
    }
    const head = Math.floor(room * HEAD_SHARE);
    return `${text.slice(0, head)}\n\n[… the middle of the conversation is left out to fit …]\n\n${text.slice(text.length - (room - head))}`;
};

const SUMMARY_ANSWER = {
    what: "a hand-off summary",
    read: (reply: string): string => reply.trim(),
    unusable: (value: string): string | undefined => (value.length < 200 ? "the summary was too short to carry the conversation" : undefined),
};

// Room left for the transcript once the instructions and the answer are allowed for, in characters.
const PROMPT_SLACK = 40_000;

// The summary note a fresh session opens with, and how it went; the note is absent when no model wrote one, and the
// turn then opens with the short record hand-off alone.
export const summaryNote = async (
    services: Services,
    execution: AgentExecutionContext,
    params: {
        readonly conversationId: string;
        readonly rows: readonly TranscriptRow[];
        readonly contextTokens: number | undefined;
        readonly signal: AbortSignal | undefined;
    },
): Promise<{ readonly note?: TurnNote; readonly event: HandedOff }> => {
    const from = params.contextTokens;
    try {
        const { value, choice } = await askRoleModel(
            services,
            execution,
            "handoff-summary",
            {
                prompt: (room) =>
                    `${SUMMARY_INSTRUCTIONS}\n\n<transcript>\n${renderRecord(params.rows, Number.isFinite(room) ? Math.max(20_000, room - PROMPT_SLACK) : 600_000)}\n</transcript>`,
                answer: SUMMARY_ANSWER,
            },
            params.signal ?? new AbortController().signal,
            { conversationId: params.conversationId },
        );
        return {
            note: { title: SUMMARY_NOTE_TITLE, text: value },
            event: { mode: "summary", model: choice.model, ...(from === undefined ? {} : { from }) },
        };
    } catch (error) {
        services.logger.warn({ err: error, conversationId: params.conversationId }, "hand-off: no summary was written, opening with the record alone");
        return { event: { mode: "summary", fellBack: true } };
    }
};
