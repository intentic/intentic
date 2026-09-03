import { type AgentEvent, type AgentReply, type AttachFrame, isTurnFact } from "@intentic/sandbox-contract";
import { TranscriptFold, userRow } from "@intentic/sandbox-contract/transcript-fold";
import type { DaemonClient } from "../daemon-client.js";

/* An in-memory DaemonClient double: scenario-driven canned AgentEvent streams per prompt keyword, folded into
 * the attach stream by the daemon's own fold (the contract's transcript-fold.ts, which is what the real daemon
 * runs), recording every reply post. The bridge under test is the real one (real SDK JSON-RPC via in-process
 * app composition); only the HTTP layer is faked. The HTTP layer itself (SSE framing, auth statuses) has its
 * own test over a real node:http server in daemon-client.test.ts. */

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
            async *streamTurn(turn, signal) {
                prompts.push(turn.prompt);
                const startedAt = Date.now();
                const fold = new TranscriptFold([userRow(turn.prompt, startedAt, [])]);
                let seq = 0;
                yield { kind: "attached", run: `run-${prompts.length}`, startedAt, seq, rows: structuredClone(fold.rows) };
                for (const event of scenario(turn.prompt)) {
                    if (signal.aborted) {
                        throw new Error("aborted");
                    }
                    for (const patch of fold.apply(event)) {
                        yield { kind: "patch", seq: ++seq, patch } satisfies AttachFrame;
                    }
                    if (isTurnFact(event)) {
                        yield { kind: "fact", seq: ++seq, fact: event } satisfies AttachFrame;
                    }
                }
                for (const patch of fold.finish("settled")) {
                    yield { kind: "patch", seq: ++seq, patch } satisfies AttachFrame;
                }
                yield { kind: "end" };
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
