import { unstubbed } from "@intentic/testing";
import type { CapabilityStatus } from "@intentic/sandbox-contract/schemas/capabilities";
import type { CapabilityCtx } from "../capability.js";
import { agentHandler } from "./agent.handler.js";

const workspace = unstubbed<CapabilityCtx["workspace"]>("workspace", { root: "/workspace" });

const context = (status: CapabilityStatus): CapabilityCtx =>
    unstubbed("capability", {
        workspace,
        probePiAgent: async () => status,
    });

test("Pi apply accepts pending installation and sign-in; status uses its RPC probe rather than ACP", async () => {
    for (const state of ["pending", "active"] as const) {
        const status = { state, detail: "Pi's own status" };
        const ctx = context(status);
        const lines = [];
        for await (const line of agentHandler.apply(ctx, "pi", { command: "pi" })) {
            lines.push(line);
        }
        expect(lines).toEqual([{ kind: "log", message: "Pi's own status" }]);
        expect(await agentHandler.status(ctx, "pi", { command: "pi" })).toEqual(status);
    }
});

test("other installed agents still use their ACP initialize probe", async () => {
    const ctx = unstubbed<CapabilityCtx>("capability", {
        workspace,
        probeAcpAgent: async () => ({ protocolVersion: 1, agentName: "Another agent", capabilities: {} }),
    });
    const lines = [];
    for await (const line of agentHandler.apply(ctx, "other", { command: "agent --acp" })) {
        lines.push(line);
    }
    expect(lines).toEqual([
        { kind: "log", message: "Connected to Another agent over ACP (protocol v1), it appears as a provider in the chat picker." },
    ]);
    expect(await agentHandler.status(ctx, "other", { command: "agent --acp" })).toEqual({ state: "active", detail: "ACP v1" });
});

test("an invalid Pi command fails apply and reports an error status", async () => {
    const ctx = unstubbed<CapabilityCtx>("capability", {
        workspace,
        probePiAgent: async () => {
            throw new Error("Pi RPC refused");
        },
    });
    await expect(agentHandler.apply(ctx, "pi", { command: "wrong" }).next()).rejects.toThrow("Pi RPC refused");
    expect(await agentHandler.status(ctx, "pi", { command: "wrong" })).toEqual({ state: "error", detail: "Pi RPC refused" });
});
