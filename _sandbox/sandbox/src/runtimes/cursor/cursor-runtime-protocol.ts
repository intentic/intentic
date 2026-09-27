import type { AgentOptions, InteractionUpdate, LocalAgentOptions, SDKCustomTool, SDKCustomToolResult, SDKJsonValue, SendOptions } from "@cursor/sdk";

// The wire between the daemon and the Cursor runtime process an isolated turn runs its SDK in (cursor-host.ts spawns
// it, cursor-agent-runtime.ts is it). Node's IPC channel with its default JSON serialization, which is why every shape
// here is the SDK's own option or result type with its callbacks taken out: a function cannot cross, so each one the
// SDK is handed becomes a message the other side answers.

// Everything AgentOptions carries but the in-process callbacks and the store object. The custom tools cross as their
// descriptions (WireTool) and are executed back in the daemon; the store is the SDK's default in both processes.
export type WireLocalOptions = Omit<LocalAgentOptions, "customTools" | "store">;
export type WireAgentOptions = Omit<AgentOptions, "local"> & { readonly local?: WireLocalOptions };
export type WireSendOptions = Omit<SendOptions, "onDelta" | "onStep">;
export type WireTool = Omit<SDKCustomTool, "execute"> & { readonly name: string };

// The SDK error classes the daemon's codedError tells apart, in the order it tests them. An error crosses as its message
// and the first of these it is an instance of, and is rebuilt on the daemon's side as an instance of the same class.
export const CODED_ERRORS = ["RateLimitError", "AuthenticationError", "AgentBusyError", "AgentNotFoundError", "NetworkError"] as const;
export type CodedError = (typeof CODED_ERRORS)[number];

export interface WireError {
    readonly message: string;
    readonly coded?: CodedError;
}

// What `Run.wait()` resolves to, cut to the fields the adapter reads.
export interface WireRunResult {
    readonly status: string;
    readonly error?: { readonly message: string };
}

export type SteerOutcome = "complete_delivered" | "revert_to_followup";

// One call per SDK method the adapter reaches, each answered by one reply carrying its `seq`. Runs are named by a
// number the daemon picks, so a `wait` or a `cancel` can go out before `send`'s own reply has come back.
export type HostCall =
    | { readonly method: "open"; readonly resume: string | undefined; readonly options: WireAgentOptions; readonly tools: readonly WireTool[] }
    | { readonly method: "send"; readonly run: number; readonly prompt: string; readonly options: WireSendOptions }
    | { readonly method: "wait"; readonly run: number }
    | { readonly method: "cancel"; readonly run: number }
    | { readonly method: "steer"; readonly run: number; readonly text: string }
    | { readonly method: "close" };

// What each call's reply carries, by method; `null` for a call answered by having happened.
export interface CallResults {
    readonly open: { readonly agentId: string };
    readonly send: { readonly steerable: boolean };
    readonly wait: WireRunResult;
    readonly cancel: null;
    readonly steer: SteerOutcome | null;
    readonly close: null;
}
export type CallMethod = HostCall["method"];
export type CallResult = CallResults[CallMethod];

// Daemon → runtime: the calls above, and the answer to a custom tool the SDK invoked there.
export type HostMessage =
    | { readonly kind: "call"; readonly seq: number; readonly call: HostCall }
    | { readonly kind: "tool-reply"; readonly call: number; readonly ok: true; readonly value: SDKCustomToolResult }
    | { readonly kind: "tool-reply"; readonly call: number; readonly ok: false; readonly message: string };

// Runtime → daemon: replies, the deltas `send({ onDelta })` streams, and a custom tool call to execute in the daemon.
export type RuntimeMessage =
    | { readonly kind: "reply"; readonly seq: number; readonly ok: true; readonly value: CallResult }
    | { readonly kind: "reply"; readonly seq: number; readonly ok: false; readonly error: WireError }
    | { readonly kind: "delta"; readonly run: number; readonly update: InteractionUpdate }
    | {
          readonly kind: "tool";
          readonly call: number;
          readonly name: string;
          readonly args: Record<string, SDKJsonValue>;
          readonly toolCallId?: string;
      };
