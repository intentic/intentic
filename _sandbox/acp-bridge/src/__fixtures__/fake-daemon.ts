import type { AgentEvent, AgentReply } from "@intentic/sandbox-contract";
import type { DaemonClient } from "../daemon-client.js";

/* An in-memory DaemonClient double: scenario-driven canned AgentEvent streams per prompt keyword, recording
 * every reply post, the bridge under test is the real one (real SDK JSON-RPC via in-process app
 * composition); only the HTTP layer is faked. The HTTP layer itself (SSE framing, auth statuses) has its own
 * test over a real node:http server in daemon-client.test.ts. */

export interface FakeDaemon {
    readonly client: DaemonClient;
    // Every /agent/reply the bridge posted, in order; filter by `kind` to assert on one card type.
    readonly replies: AgentReply[];
    readonly prompts: string[];
}

export const fakeDaemon = (scenario: (prompt: string) => AgentEvent[]): FakeDaemon => {
    const replies: FakeDaemon["replies"] = [];
    const prompts: string[] = [];
    return {
        replies,
        prompts,
        client: {
            streamTurn: async function* (turn, signal) {
                prompts.push(turn.prompt);
                for (const event of scenario(turn.prompt)) {
                    if (signal.aborted) {
                        throw new Error("aborted");
                    }
                    yield event;
                }
            },
            postReply: async (reply) => {
                replies.push(reply);
            },
            getSession: async () => [
                { role: "user", text: "earlier question" },
                { role: "assistant", text: "earlier answer" },
            ],
            listSessions: async () => {},
        },
    };
};
