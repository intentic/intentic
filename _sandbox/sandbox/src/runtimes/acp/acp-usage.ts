import type { PromptResponse } from "@agentclientprotocol/sdk/unstable";
import type { AgentEvent } from "@intentic/sandbox-contract/events/agent-events";
import type { AcpConnection } from "./acp-connection.js";

/* WHAT AN ACP TURN COST, WHERE THE AGENT SAYS.

   The protocol's prompt response may carry token usage (unstable `usage`): the session's running totals, as its fields
   describe them, though some agents count the one turn. What this turn added is read as the difference from the last
   reading on the same session of the same process, and a reading smaller than that one is taken as a turn's own count.
   An agent that reports nothing is recorded as reporting nothing, never as a turn that cost zero. 2026-10-25: every
   ACP turn was recorded at zero tokens (Devin's 28 among them), the usage on its response never read. */

interface Totals {
    readonly input: number;
    readonly output: number;
    readonly cacheRead: number;
    readonly cacheWrite: number;
}

// The last totals each session reported, per process that served it: a process's sessions end with it.
const seen = new WeakMap<AcpConnection, Map<string, Totals>>();

const grew = (now: Totals, last: Totals): boolean =>
    now.input >= last.input && now.output >= last.output && now.cacheRead >= last.cacheRead && now.cacheWrite >= last.cacheWrite;

/** This turn's usage frame from the prompt response `process` gave for `session`, or undefined where it reported none. */
export const promptUsage = (process: AcpConnection, session: string, response: PromptResponse | undefined): AgentEvent | undefined => {
    const usage = response?.usage;
    if (usage === undefined || usage === null) {
        return undefined;
    }
    const now: Totals = {
        input: usage.inputTokens,
        output: usage.outputTokens,
        cacheRead: usage.cachedReadTokens ?? 0,
        cacheWrite: usage.cachedWriteTokens ?? 0,
    };
    const sessions = seen.get(process) ?? new Map<string, Totals>();
    seen.set(process, sessions);
    const last = sessions.get(session);
    sessions.set(session, now);
    const turn =
        last === undefined || !grew(now, last)
            ? now
            : { input: now.input - last.input, output: now.output - last.output, cacheRead: now.cacheRead - last.cacheRead, cacheWrite: now.cacheWrite - last.cacheWrite };
    return { kind: "usage", inputTokens: turn.input, outputTokens: turn.output, cacheReadTokens: turn.cacheRead, cacheCreationTokens: turn.cacheWrite };
};
