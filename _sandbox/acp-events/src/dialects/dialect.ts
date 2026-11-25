import type { SessionNotification, ToolCall, ToolCallUpdate } from "@agentclientprotocol/sdk/unstable";
import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import type { AskQuestion } from "@intentic/sandbox-contract/events/requests";
import type { AgentReply } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import { opt } from "../opt.js";

// An ACP dialect: what one agent says beyond the protocol (its own `_vendor/…` notifications and requests, its own
// session-update kinds, its own tool shapes) read into the frames every runtime already draws. Each hook is optional, and
// an agent without a dialect reads as plain ACP. Pure readers: no process, no socket. The daemon's connection
// (runtimes/acp) and a computer's (host-agents) decide what a reading does.
//
// Nothing here adds a frame kind: a subagent is the `subagent`/`subagent_update` pair the Claude loop's Task tool
// raises, its own words and calls are frames tagged with the spawning call's id, and a background task's ending is a
// `tool_call_update` on the call that started it. So an older editor draws every reading.

// What a JSON-RPC message carries: it arrived as JSON text, so it is JSON.
export type Json = string | number | boolean | null | readonly Json[] | { readonly [key: string]: Json };

// A protocol error as the agent answered a request, for a probe that tells support from absence by the error.
export interface RequestOutcome {
    readonly result?: Json;
    readonly error?: { readonly code: number; readonly data?: Json };
}

// Ending one child (a subagent, a background task) through the agent's own method. Support is probed first, with
// params that name no child, so finding out never stops anything: `supported` reads that probe's outcome.
export interface ChildStop {
    readonly method: string;
    readonly probe: Json;
    readonly supported: (outcome: RequestOutcome) => boolean;
    readonly params: (sessionId: string, id: string) => Json;
}

// A question the agent asks through a request of its own rather than ACP's form elicitation, as the question card every
// runtime shares asks it, and the agent's own answer shapes for a reply and for nobody answering.
export interface VendorQuestion {
    readonly sessionId: string;
    readonly questions: readonly AskQuestion[];
    readonly answer: (reply: Extract<AgentReply, { kind: "question" }>) => Json;
    readonly cancelled: Json;
}

// Frames a reading puts on one session's turn.
export interface DialectFrames {
    readonly sessionId: string;
    readonly events: readonly AgentEvent[];
}

// A session the agent opened for one of its subagents: its updates belong on its parent's turn, under the call that
// spawned it.
export interface ChildSession {
    readonly parentSessionId: string;
    readonly callId: string;
}

// The children still running in a session, by the id each stop method takes.
export interface LiveChildren {
    readonly subagents: readonly string[];
    readonly tasks: readonly string[];
}

// What one connection to the agent remembers between messages: which call spawned which subagent, which session is a
// child's, what still runs. One per connection, since ids are the process's own.
export interface DialectReader {
    // A notification outside session/update, by its method as sent (`_x.ai/…`). Undefined: not this dialect's, which
    // the caller drops as before.
    readonly notification: (method: string, params: Json) => readonly DialectFrames[] | undefined;
    // Every standard tool call and update of a session, before its card is read: frames it implies beyond the card.
    readonly toolUpdate: (sessionId: string, update: ToolCall | ToolCallUpdate) => readonly AgentEvent[];
    readonly childOf: (sessionId: string) => ChildSession | undefined;
    // Work the agent will wake itself up to report once the prompt has answered (reactive wake-ups): the turn stays open
    // while this holds, so the wake's words land on it rather than on no turn at all.
    readonly holding: (sessionId: string) => boolean;
    readonly live: (sessionId: string) => LiveChildren;
}

export interface AcpDialect {
    readonly id: string;
    // The CLI and version the dialect was read off, and how (recorded traffic, its source).
    readonly writtenAgainst: string;
    readonly reader: () => DialectReader;
    // A tool update rewritten before its card is read, for an agent whose updates say in words what ACP has fields for.
    readonly normalizeToolUpdate?: (update: ToolCallUpdate) => ToolCallUpdate;
    readonly normalizeToolCall?: (call: ToolCall) => ToolCall;
    // A request of the agent's own that asks a person something. Undefined: not a question.
    readonly question?: (method: string, params: Json) => VendorQuestion | undefined;
    readonly subagentStop?: ChildStop;
    readonly taskStop?: ChildStop;
}

// The reader of an agent with no notifications of its own.
export const plainReader = (): DialectReader => ({
    notification: () => undefined,
    toolUpdate: () => [],
    childOf: () => undefined,
    holding: () => false,
    live: () => ({ subagents: [], tasks: [] }),
});

// An extension method's name without the protocol's `_` prefix, the way agents and their docs spell it.
export const vendorMethod = (method: string): string => (method.startsWith("_") ? method.slice(1) : method);

// A child session's frame as its parent's turn shows it: its words and calls under the spawning call's card, its call ids
// kept apart from the parent's, and what only describes the child's own session (its commands, context, checklist) left
// out. Undefined for a frame the parent's turn does not show.
export const childFrame = (event: AgentEvent, child: ChildSession, childSessionId: string): AgentEvent | undefined => {
    const own = (id: string): string => `${childSessionId}/${id}`;
    switch (event.kind) {
        case "delta":
        case "thinking":
            return { ...event, parentToolUseId: child.callId };
        case "tool_call":
            return { ...event, id: own(event.id), parentToolUseId: child.callId };
        case "tool_call_update":
            return { ...event, id: own(event.id) };
        default:
            return undefined;
    }
};

// Where one session/update belongs under a dialect: on its own session's turn, or, for a child session the agent opened
// for a subagent, on its parent's (`child` set, its frames read through `childFrame`). `extra` is what a tool update
// implies beyond its card (`DialectReader.toolUpdate`), drawn after it on the same turn.
export interface PlacedUpdate {
    readonly sessionId: string;
    readonly child: ChildSession | undefined;
    readonly extra: readonly AgentEvent[];
}

export const placeUpdate = (reader: DialectReader, notification: SessionNotification): PlacedUpdate => {
    const { sessionId, update } = notification;
    const child = reader.childOf(sessionId);
    const extra = update.sessionUpdate === "tool_call" || update.sessionUpdate === "tool_call_update" ? reader.toolUpdate(sessionId, update) : [];
    return { sessionId: child?.parentSessionId ?? sessionId, child, extra };
};

// What `sessionUpdateEvent` takes of a dialect (events.ts UpdateReading), present hooks only.
export const dialectReading = (dialect: AcpDialect | undefined): Pick<AcpDialect, "normalizeToolUpdate" | "normalizeToolCall"> => ({
    ...opt("normalizeToolUpdate", dialect?.normalizeToolUpdate),
    ...opt("normalizeToolCall", dialect?.normalizeToolCall),
});
