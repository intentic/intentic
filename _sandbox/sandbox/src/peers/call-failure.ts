// A call forwarded to a peer that fails on the way (not one the peer answered with an error) used to reach the agent as
// the transport's own words: "[AsyncIdQueue] Queue[17] was closed or aborted while waiting for pulling." or "The
// operation timed out.", neither of which says what happened to the command. An agent read the first as a broken tool
// and the second as a refusal, and retried a command that may have run. Each is said here as what it means for the
// call: the peer dropped the connection mid-call, or the call outran the bridge's deadline, and in both cases it may
// have run (or still be running) out there.

// oRPC's websocket link aborting its pending calls when the socket closes, ws refusing a send on a closed socket, and
// node's own reset: all the connection going away under a call already sent.
const DROPPED = /AsyncIdQueue|closed or aborted while waiting|WebSocket is not open|socket hang up|ECONNRESET|connection (was )?closed/iu;

const isTimeout = (error: Error): boolean =>
    (error instanceof DOMException && error.name === "TimeoutError") || /operation timed out|aborted due to timeout/iu.test(error.message);

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
    if (isTimeout(error)) {
        return {
            kind: "timeout",
            text: `"${id}" did not answer ${call} within ${seconds(deadlineMs)}, so the bridge stopped waiting. It may still be running on that ${noun}: check its result before running it again.`,
        };
    }
    const raw = error.message;
    if (DROPPED.test(raw)) {
        return {
            kind: "dropped",
            text: `"${id}" dropped its connection while ${call} was running (the ${noun} went to sleep, lost its network, or its agent restarted). It may or may not have finished there: check before running it again.`,
        };
    }
    return { kind: "other", text: raw };
};
