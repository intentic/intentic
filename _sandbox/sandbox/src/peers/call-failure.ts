import { networkCodeOf } from "@intentic/base/errors";
import { ORPCError } from "@orpc/client";

// A call forwarded to a peer that fails on the way (not one the peer answered with an error) used to reach the agent as
// the transport's own words: "[AsyncIdQueue] Queue[17] was closed or aborted while waiting for pulling." or "The
// operation timed out.", neither of which says what happened to the command. An agent read the first as a broken tool
// and the second as a refusal, and retried a command that may have run. Each is said here as what it means for the
// call: the peer dropped the connection mid-call, or the call outran the bridge's deadline, and in both cases it may
// have run (or still be running) out there.

// The connection going away under a call already sent, read by structure first: oRPC's link rejects every pending call
// with an AbortError of its own (not the DOMException a caller's abort is) when its socket closes, a reset socket carries
// its errno, and a deadline is AbortSignal.timeout's DOMException. An ORPCError is the peer's own answer: the link was up.
const DROPPED_CODES = new Set(["ECONNRESET", "EPIPE", "ECONNABORTED", "UND_ERR_SOCKET"]);

// oRPC's link refusing a send on a closed socket (a bare Error), its AsyncIdQueue, node's http, and a deadline's words
// once something re-wrapped it as a plain Error.
const DROPPED_WORDS = /closed or aborted while waiting for pulling|WebSocket is not open|socket hang up/iu;
const TIMEOUT_WORDS = /operation timed out|aborted due to timeout/iu;

const kindOf = (error: Error): CallFailure["kind"] => {
    if (error instanceof DOMException) {
        return error.name === "TimeoutError" ? "timeout" : "other";
    }
    if (error instanceof ORPCError) {
        return "other";
    }
    if (error.name === "AbortError") {
        return "dropped";
    }
    const code = networkCodeOf(error);
    if (code !== undefined) {
        return DROPPED_CODES.has(code) ? "dropped" : "other";
    }
    // allow(dependency-text): oRPC 1.x's websocket link, node's http and AbortSignal; an unmatched wording passes the transport's words through as `other`.
    return TIMEOUT_WORDS.test(error.message) ? "timeout" : DROPPED_WORDS.test(error.message) ? "dropped" : "other";
};

const seconds = (ms: number): string => (ms >= 120_000 ? `${Math.round(ms / 60_000)} minutes` : `${Math.round(ms / 1000)} s`);

export interface CallFailure {
    // What the agent reads in place of the transport's words.
    readonly text: string;
    // Which way it failed, for the log line beside it; `other` is passed through verbatim.
    readonly kind: "dropped" | "timeout" | "other";
}

/** A forwarded call's transport failure in words an agent can act on; anything not recognised is passed through as it was. */
export const callFailure = (noun: string, id: string, tool: string | undefined, error: Error, deadlineMs: number): CallFailure => {
    const call = tool === undefined || tool === "" ? "the call" : `the ${tool} call`;
    const kind = kindOf(error);
    if (kind === "timeout") {
        return {
            kind: "timeout",
            text: `"${id}" did not answer ${call} within ${seconds(deadlineMs)}, so the bridge stopped waiting. It may still be running on that ${noun}: check its result before running it again.`,
        };
    }
    if (kind === "dropped") {
        return {
            kind: "dropped",
            text: `"${id}" dropped its connection while ${call} was running (the ${noun} went to sleep, lost its network, or its agent restarted). It may or may not have finished there: check before running it again.`,
        };
    }
    return { kind: "other", text: error.message };
};
