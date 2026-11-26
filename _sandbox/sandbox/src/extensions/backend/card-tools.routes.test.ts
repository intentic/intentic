import { Hono } from "hono";
import type { AppEnv } from "../../app-env.js";
import { createTurnMounts, type MountTarget, type RpcMessage } from "../../agent/tools/turn-mounts.js";
import type { MountCall } from "../../agent/tools/turn-mounts.routes.js";
import { CONVERSATION_HEADER, TURN_PROOF_HEADER, turnProof } from "../../seams/workload-stamp.js";
import { createCardToolsRoute } from "./card-tools.routes.js";

// A card's CLI reaches the tools its extension's backend serves for that card through the turn's own shell
// (`POST /tools/<card>`): only for a conversation proven by its turn's proof, only while a live turn of it mounted that
// card's tools, and with the conversation the door resolved, never one the request names.

type ToolsTarget = Extract<MountTarget, { readonly kind: "tools" }>;

const harness = () => {
    const mounts = createTurnMounts({ baseUrl: () => "http://127.0.0.1:1/mcp" });
    const calls: { readonly target: ToolsTarget; readonly message: RpcMessage; readonly call: MountCall }[] = [];
    const app = new Hono<AppEnv>();
    app.post(
        "/tools/:mount",
        createCardToolsRoute({ turnMounts: mounts, secretRegistry: async () => [{ name: "office/password", value: "hunter2-hunter2-hunter2", source: "capability" }] }, async (target, message, call) => {
            calls.push({ target, message, call });
            return { jsonrpc: "2.0", id: message.id ?? null, result: { content: [{ type: "text", text: "sent with hunter2-hunter2-hunter2" }] } };
        }),
    );
    const ask = (card: string, conversation: string | undefined, proof?: string, body: unknown = { jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "send", arguments: {} } }) => {
        const headers = new Headers({ "content-type": "application/json" });
        if (conversation !== undefined) {
            headers.set(CONVERSATION_HEADER, conversation);
            headers.set(TURN_PROOF_HEADER, proof ?? turnProof(conversation));
        }
        return app.request(`/tools/${card}`, { method: "POST", headers, body: JSON.stringify(body) });
    };
    return { mounts, calls, ask };
};

test("a proven conversation whose turn mounted the card's tools reaches them, as itself", async () => {
    const { mounts, calls, ask } = harness();
    const lease = mounts.lease("conv-a");
    lease.open({ name: "my-office", target: { kind: "tools", extension: "imap", card: "my-office" } });
    const answered = await ask("my-office", "conv-a");
    expect(answered.status).toBe(200);
    // A stored secret's value is masked on the way back, as the MCP door masks it for the model.
    expect(await answered.json()).toEqual({ jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "sent with {{secret:office/password}}" }] } });
    expect(calls).toHaveLength(1);
    expect(calls[0]?.target).toEqual({ kind: "tools", extension: "imap", card: "my-office" });
    expect(calls[0]?.call.conversationId).toBe("conv-a");
    expect(calls[0]?.message).toEqual({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "send", arguments: {} } });
    // The CLI knows a card by its environment suffix (IMAP_HOST_MY_OFFICE), which names the same card.
    expect((await ask("my_office", "conv-a")).status).toBe(200);
    lease.release();
    expect((await ask("my-office", "conv-a")).status).toBe(403);
    expect(calls).toHaveLength(2);
});

test("a shell naming no conversation, or one without its proof, or one whose turn lacks the card, reaches nothing", async () => {
    const { mounts, calls, ask } = harness();
    mounts.lease("conv-a").open({ name: "office", target: { kind: "tools", extension: "imap", card: "office" } });
    mounts.lease("conv-b").open({ name: "rog", target: { kind: "device", id: "rog" } });
    expect((await ask("office", undefined)).status).toBe(400);
    const forged = await ask("office", "conv-a", "0".repeat(64));
    expect(forged.status).toBe(403);
    expect(await forged.text()).toContain("without the proof");
    expect((await ask("office", "conv-b")).status).toBe(403);
    // A mount that is not a card's tools is not reached here, whatever it is called.
    expect((await ask("rog", "conv-b")).status).toBe(403);
    expect(calls).toEqual([]);
});

test("only one JSON-RPC request with an id is taken", async () => {
    const { mounts, calls, ask } = harness();
    mounts.lease("conv-a").open({ name: "office", target: { kind: "tools", extension: "imap", card: "office" } });
    expect((await ask("office", "conv-a", undefined, [{ jsonrpc: "2.0", id: 1, method: "tools/list" }])).status).toBe(400);
    expect((await ask("office", "conv-a", undefined, { jsonrpc: "2.0", method: "notifications/initialized" })).status).toBe(400);
    expect(calls).toEqual([]);
});
