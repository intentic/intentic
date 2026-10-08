import type { PrivacyShieldPolicy } from "@intentic/sandbox-contract";
import { Hono } from "hono";
import type { AppEnv } from "../../app-env.js";
import { createMcpRoute } from "../gateway/mcp-route.js";
import { privacySliceFake } from "../privacy-slice.testing.js";
import { pesel } from "../detect/tests/ids.testing.js";
import { tokenOf } from "../tokens.js";

// The masking proxy a hooked runtime's (Cursor's) MCP calls go through, over the real shield and a stand-in server: the
// model must never read a value the server answered with, the server must act on the real values the model's tokens
// stand for, and what only describes the server goes as it was.

const NUMBER = pesel(1985, 3, 14, 4562);
const TOKEN = tokenOf("NATIONAL_ID", 1);

interface Server {
    readonly fetch: typeof fetch;
    readonly seen: { url: string; body: string; headers: Headers }[];
}

const server = (answer: (body: string) => Response): Server => {
    const seen: { url: string; body: string; headers: Headers }[] = [];
    return {
        seen,
        fetch: (async (input: string | URL | Request, init?: RequestInit) => {
            const body = typeof init?.body === "string" ? init.body : "";
            seen.push({ url: String(input), body, headers: new Headers(init?.headers) });
            return answer(body);
        }) as typeof fetch,
    };
};

const json = (value: unknown): Response => new Response(JSON.stringify(value), { headers: { "content-type": "application/json" } });

// A tool call's answer quoting the record it looked up, for whatever id the call carried.
const lookup = (body: string): Response => {
    const call = JSON.parse(body) as { id: number; params?: { arguments?: { id?: string } } };
    return json({ jsonrpc: "2.0", id: call.id, result: { content: [{ type: "text", text: `record for ${call.params?.arguments?.id ?? "?"}: PESEL ${NUMBER}` }] } });
};

const harness = async (policy: Partial<PrivacyShieldPolicy>, answer: (body: string) => Response = lookup) => {
    const fake = privacySliceFake({ policy });
    const upstream = server(answer);
    const app = new Hono<AppEnv>();
    const warnings: string[] = [];
    app.all("/privacy/mcp/:session", createMcpRoute({ shield: fake.privacyShield, warn: (message) => warnings.push(message), fetch: upstream.fetch }));
    // Signed as a turn's shield signs it (TurnShield.mcpUrl), which an off or trusting policy hands out no shield for.
    const session = await fake.privacyShield.tokens.sign({ provider: "cursor", upstream: "http://127.0.0.1:8787/mcp/crm", conversationId: "c-1" });
    const send = (message: unknown, headers: Record<string, string> = {}) =>
        app.request(`/privacy/mcp/${session}`, {
            method: "POST",
            headers: { "content-type": "application/json", accept: "application/json, text/event-stream", authorization: "Bearer turn-1", ...headers },
            body: JSON.stringify(message),
        });
    return { fake, upstream, send, warnings };
};

const call = (id: string) => ({ jsonrpc: "2.0", id: 7, method: "tools/call", params: { name: "lookup", arguments: { id } } });

test("what a server answers is masked before the runtime reads it, and the model's tokens reach the server as values", async () => {
    const { fake, upstream, send } = await harness({ mode: "on" });
    // The model holds a token from earlier in the turn.
    const shield = await fake.privacyShield.forTurn("cursor", "native", "c-1");
    expect(await shield?.mask(`PESEL ${NUMBER}`, "shell")).toBe(`PESEL ${TOKEN}`);
    const answer = (await (await send(call(TOKEN))).json()) as { result: { content: { text: string }[] } };
    expect(upstream.seen[0]?.body).toContain(NUMBER);
    expect(upstream.seen[0]?.body).not.toContain(TOKEN);
    expect(upstream.seen[0]?.url).toBe("http://127.0.0.1:8787/mcp/crm");
    // The runtime's own bearer travels to the server as it would have.
    expect(upstream.seen[0]?.headers.get("authorization")).toBe("Bearer turn-1");
    expect(JSON.stringify(answer)).not.toContain(NUMBER);
    expect(answer.result.content[0]?.text).toBe(`record for ${TOKEN}: PESEL ${TOKEN}`);
    await Promise.resolve();
    expect(fake.privacyLedger.entries.at(-1)).toEqual(expect.objectContaining({ action: "masked", protocol: "hooks:mcp", conversationId: "c-1" }));
});

test("a streamed answer is masked event by event", async () => {
    const { send } = await harness({ mode: "on" }, (body) => {
        const id = (JSON.parse(body) as { id: number }).id;
        const event = { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: `PESEL ${NUMBER}` }] } };
        return new Response(`event: message\ndata: ${JSON.stringify(event)}\n\n`, { headers: { "content-type": "text/event-stream" } });
    });
    const text = await (await send(call("x"))).text();
    expect(text).not.toContain(NUMBER);
    expect(text).toContain(TOKEN);
    expect(text.startsWith("event: message\n")).toBe(true);
});

test("what only describes the server (its tool list) goes as it was", async () => {
    const tools = { jsonrpc: "2.0", id: 1, result: { tools: [{ name: "lookup", description: `Finds a record, e.g. PESEL ${NUMBER}`, inputSchema: { type: "object" } }] } };
    const { send } = await harness({ mode: "on" }, () => json(tools));
    expect(await (await send({ jsonrpc: "2.0", id: 1, method: "tools/list" })).json()).toEqual(tools);
});

test("a picture nothing can read is held back with a note, and audio with it", async () => {
    const { send } = await harness({ mode: "on" }, (body) =>
        json({
            jsonrpc: "2.0",
            id: (JSON.parse(body) as { id: number }).id,
            result: {
                content: [
                    { type: "image", data: "aGVsbG8=", mimeType: "image/png" },
                    { type: "audio", data: "aGVsbG8=", mimeType: "audio/wav" },
                ],
            },
        }),
    );
    const answer = (await (await send(call("x"))).json()) as { result: { content: { type: string; text?: string }[] } };
    expect(answer.result.content.map((block) => block.type)).toEqual(["text", "text"]);
    expect(answer.result.content[0]?.text).toContain("withheld by the privacy shield");
});

test("watching, it reads and logs but sends everything as it came; off or trusted, a plain relay", async () => {
    const watching = await harness({ mode: "watch" });
    const watched = await (await watching.send(call("x"))).text();
    expect(watched).toContain(NUMBER);
    await Promise.resolve();
    expect(watching.fake.privacyLedger.entries.at(-1)).toEqual(expect.objectContaining({ action: "watched" }));
    for (const policy of [{ mode: "off" as const }, { mode: "on" as const, trusted: ["cursor"] }]) {
        const relay = await harness(policy);
        expect(await (await relay.send(call("x"))).text()).toContain(NUMBER);
        expect(relay.fake.privacyLedger.entries).toEqual([]);
    }
});

test("a session nobody signed is refused", async () => {
    const fake = privacySliceFake({ policy: { mode: "on" } });
    const app = new Hono<AppEnv>();
    app.all("/privacy/mcp/:session", createMcpRoute({ shield: fake.privacyShield, warn: () => {}, fetch: server(lookup).fetch }));
    expect((await app.request("/privacy/mcp/forged", { method: "POST", body: "{}" })).status).toBe(404);
});
