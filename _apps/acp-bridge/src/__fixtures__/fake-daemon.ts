import type { AgentEvent } from "@intentic/sandbox-contract";
import type { DaemonClient } from "../daemon-client.js";

/* An in-memory DaemonClient double: scenario-driven canned AgentEvent streams per prompt keyword, recording
 * every decision/answer post — the bridge under test is the real one (real SDK JSON-RPC via in-process app
 * composition); only the HTTP layer is faked. The HTTP layer itself (SSE framing, auth statuses) has its own
 * test over a real node:http server in daemon-client.test.ts. */

export interface FakeDaemon {
    readonly client: DaemonClient;
    readonly decisions: { decisionId: string; approve: boolean; feedback?: string }[];
    readonly answers: { requestId: string; answers?: Record<string, string[]> }[];
    readonly prompts: string[];
}

export const fakeDaemon = (scenario: (prompt: string) => AgentEvent[]): FakeDaemon => {
    const decisions: FakeDaemon["decisions"] = [];
    const answers: FakeDaemon["answers"] = [];
    const prompts: string[] = [];
    return {
        decisions,
        answers,
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
            postDecision: async (decisionId, approve, feedback) => {
                decisions.push({ decisionId, approve, ...(feedback !== undefined ? { feedback } : {}) });
            },
            postAnswer: async (requestId, recorded) => {
                answers.push({ requestId, ...(recorded !== undefined ? { answers: recorded } : {}) });
            },
            getSession: async () => [
                { role: "user", text: "earlier question" },
                { role: "assistant", text: "earlier answer" },
            ],
            listSessions: async () => {},
        },
    };
};
