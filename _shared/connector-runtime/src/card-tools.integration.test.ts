import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { CardToolRefused, callCardTool } from "./card-tools.js";

// A card's CLI calls its card's tools through the daemon's shell door, naming its turn the way every agent CLI does.

test("a call goes to the contract's own door with the agent token and the turn's proof, and its text comes back", async () => {
    const dir = await mkdtemp(join(tmpdir(), "card-tools-"));
    try {
        await writeFile(join(dir, "agent.token"), "agent-secret\n");
        const env = { INTENTIC_AGENT_TOKEN_PATH: join(dir, "agent.token"), SANDBOX_PORT: "9999", INTENTIC_TURN_OWNER: "conv", INTENTIC_TURN_PROOF: "p".repeat(64) };
        const seen: { url: string; init: RequestInit }[] = [];
        const answering = (status: number, body: unknown) => async (url: string, init: RequestInit) => {
            seen.push({ url, init });
            return new Response(JSON.stringify(body), { status });
        };
        const sent = await callCardTool("my office", "send", { to: ["bob@example.com"] }, { env, http: answering(200, { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "sent" }] } }) });
        expect(sent).toEqual({ text: "sent", isError: false });
        expect(seen[0]?.url).toBe("http://127.0.0.1:9999/tools/my%20office");
        const headers = new Headers(seen[0]?.init.headers);
        expect([headers.get("x-intentic-agent"), headers.get("x-intentic-conversation"), headers.get("x-intentic-turn-proof")]).toEqual(["agent-secret", "conv", "p".repeat(64)]);
        expect(JSON.parse(String(seen[0]?.init.body))).toEqual({ jsonrpc: "2.0", id: 1, method: "tools/call", params: { name: "send", arguments: { to: ["bob@example.com"] } } });
        const refused = await callCardTool("office", "send", {}, { env, http: answering(200, { jsonrpc: "2.0", id: 1, result: { content: [{ type: "text", text: "denied" }], isError: true } }) });
        expect(refused).toEqual({ text: "denied", isError: true });
        await expect(callCardTool("office", "send", {}, { env, http: answering(403, { error: "this conversation's turn has no tools for a card called \"office\"" }) })).rejects.toThrow(
            new CardToolRefused("this conversation's turn has no tools for a card called \"office\"", 403),
        );
        await expect(callCardTool("office", "send", {}, { env, http: answering(200, { jsonrpc: "2.0", id: 1, error: { code: -32000, message: "backends are restarting" } }) })).rejects.toThrow(
            "backends are restarting",
        );
    } finally {
        await rm(dir, { recursive: true, force: true });
    }
});
