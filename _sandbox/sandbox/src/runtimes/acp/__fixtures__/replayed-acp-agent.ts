import { agent, type AgentApp, methods, type PromptResponse } from "@agentclientprotocol/sdk/unstable";
import type { Json } from "@intentic/acp-events/dialects";
import type { Line } from "@intentic/acp-events/dialects/replay";

/* An agent that says, in order, what a recorded one said (@intentic/acp-events dialects/__fixtures__), for the real
 * connection routing to read: its notifications, and its requests, whose answers it keeps. The prompt is answered with
 * the recorded answer to the recording's first prompt; what the recording says after that is said once it has. */

// SAFETY: a recorded prompt answer is the protocol's PromptResponse.
const responseOf = (result: Json | undefined): PromptResponse => (result ?? { stopReason: "end_turn" }) as PromptResponse;

export const replayedAcpAgentApp = (lines: readonly Line[], answers: Json[] = []): AgentApp => {
    const prompt = lines.find((line) => line.direction === "out" && line.message.method === "session/prompt");
    const answeredAt = lines.findIndex((line) => line.direction === "in" && line.message.method === undefined && line.message.id === prompt?.message.id);
    const incoming = (from: number, to: number) => lines.slice(from, to).filter((line) => line.direction === "in" && line.message.method !== undefined);
    return agent({ name: "replayed-agent" })
        .onRequest(methods.agent.initialize, () => ({ protocolVersion: 1, agentCapabilities: { loadSession: false } }))
        .onRequest(methods.agent.session.new, () => ({ sessionId: "session-1" }))
        .onRequest(methods.agent.session.prompt, async ({ client: ctx }) => {
            const say = async (line: Line): Promise<void> => {
                const { id, method, params } = line.message;
                if (method === undefined) {
                    return;
                }
                if (id === undefined) {
                    await ctx.notify(method, params);
                    return;
                }
                // A request the client refuses (one no dialect reads) is recorded as the refusal's code.
                answers.push(await ctx.request<Json>(method, params).catch((error: Error) => ({ refused: error.message })));
            };
            for (const line of incoming(0, answeredAt)) {
                await say(line);
            }
            setTimeout(() => {
                void (async () => {
                    for (const line of incoming(answeredAt + 1, lines.length)) {
                        await say(line);
                    }
                })();
            }, 0);
            return responseOf(lines[answeredAt]?.message.result);
        });
};
