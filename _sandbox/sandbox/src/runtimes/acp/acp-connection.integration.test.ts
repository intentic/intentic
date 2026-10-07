import { methods } from "@agentclientprotocol/sdk";
import { unstubbed } from "@intentic/testing";
import { createLogger } from "../../logger.js";
import type { TerminalRunner } from "../../terminal/terminal-run.js";
import { createAcpConnections, type TurnHooks } from "./acp-connection.js";

const logger = createLogger({ logLevel: "silent", logPretty: false, historyRoot: "" });

test("unbinding an older registration preserves the replacement turn's permission gate", async () => {
    const connections = createAcpConnections(logger, unstubbed<TerminalRunner>("terminal", { visible: false }));
    const connection = await connections.acquire(
        "fake",
        { command: "node --import tsx src/runtimes/acp/__fixtures__/fake-acp-process.ts" },
        process.cwd(),
    );
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
        await connection.agent.request(methods.agent.session.prompt, {
            sessionId: "same-session",
            prompt: [{ type: "text", text: "ask-permission" }],
        });
        expect(updates).toEqual(["permission:deny"]);
        unbind();
    } finally {
        connections.drop("fake");
    }
});

// One warm process serves every conversation on the agent, so a turn that timed out must not take the others' turns down
// with it: the process ends only once no turn is left on it.
test("a session given up on mid-turn is refused what it asks, and the process lives while another turn is on it", async () => {
    const connections = createAcpConnections(logger, unstubbed<TerminalRunner>("terminal", { visible: false }));
    const connection = await connections.acquire(
        "fake",
        { command: "node --import tsx src/runtimes/acp/__fixtures__/fake-acp-process.ts" },
        process.cwd(),
    );
    const prompt = (sessionId: string, text: string) =>
        connection.agent.request(methods.agent.session.prompt, { sessionId, prompt: [{ type: "text", text }] });
    try {
        const replies: string[] = [];
        const unbindOther = connection.bindTurn("other-conversation", {
            onUpdate: (notification) => {
                const update = notification.update;
                if (update.sessionUpdate === "agent_message_chunk" && update.content.type === "text") {
                    replies.push(update.content.text);
                }
            },
            permission: async () => ({ outcome: { outcome: "selected", optionId: "allow" } }),
        });
        const unbindStalled = connection.bindTurn("stalled", { onUpdate: () => {}, permission: async () => ({ outcome: { outcome: "cancelled" } }) });
        unbindStalled();
        connection.abandon("stalled");

        expect(connection.alive()).toBe(true);
        // Unbound and not given up on, a late ask is auto-allowed; given up on, it is refused.
        expect(await prompt("never-bound", "ask-and-report")).toMatchObject({ stopReason: "end_turn" });
        expect(await prompt("stalled", "ask-and-report")).toMatchObject({ stopReason: "cancelled" });
        await prompt("other-conversation", "hello");
        expect(replies).toEqual(["Hi there"]);

        unbindOther();
        connection.abandon("other-conversation");
        expect(connection.alive()).toBe(false);
    } finally {
        connections.drop("fake");
    }
});
