import { methods } from "@agentclientprotocol/sdk";
import { unstubbed } from "@intentic/testing";
import { createLogger } from "../../logger.js";
import type { TerminalRunner } from "../../terminal/terminal-run.js";
import { createAcpConnections, type TurnHooks } from "./acp-connection.js";

const logger = createLogger({ logLevel: "silent", logPretty: false, historyRoot: "" });

test("unbinding an older registration preserves the replacement turn's permission gate", async () => {
    const connections = createAcpConnections(logger, unstubbed<TerminalRunner>("terminal", { visible: false }));
    const connection = await connections.acquire("fake", { command: "node --import tsx src/runtimes/acp/__fixtures__/fake-acp-process.ts" }, process.cwd());
    try {
        const hooks = (optionId: string): TurnHooks => ({
            onUpdate: () => {},
            permission: async () => ({ outcome: { outcome: "selected", optionId } }),
        });
        const retire = connection.bindTurn("same-session", hooks("allow"));
        const updates: string[] = [];
        // Observe the permission answer through the real agent's response stream.
        const replacement: TurnHooks = {
            ...hooks("deny"),
            onUpdate: (notification) => {
                const update = notification.update;
                if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
                    updates.push(update.content.text);
                }
            },
        };
        const unbind = connection.bindTurn("same-session", replacement);
        retire();
        await connection.agent.request(methods.agent.session.prompt, { sessionId: "same-session", prompt: [{ type: "text", text: "ask-permission" }] });
        expect(updates).toEqual(["permission:deny"]);
        unbind();
    } finally {
        connections.drop("fake");
    }
});
