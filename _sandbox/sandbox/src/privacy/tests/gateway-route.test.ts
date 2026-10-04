import type { PrivacyShieldPolicy } from "@intentic/sandbox-contract";
import { Hono } from "hono";
import type { AppEnv } from "../../app-env.js";
import { createGatewayRoute } from "../gateway/gateway-route.js";
import { CLEARED_PLACEHOLDER } from "../gateway/tool-result-clearing.js";
import { privacySliceFake } from "../privacy-slice.testing.js";

// The gateway end to end, over the real shield (detectors, vault, masker, wire walkers) and a stand-in provider: what the
// provider is sent, what the runtime gets back, and what the log keeps. The provider must never read a value the shield
// found; the runtime must get every value back; and nothing the shield could not read may leave.

const PESEL = "44051401458";
const PERSON = "Jan Kowalski";

interface Upstream {
    readonly fetch: typeof fetch;
    readonly seen: { url: string; body: string; headers: Headers }[];
}

// Answers like the provider would: the request's own text echoed back as the model's reply, streamed or whole.
const upstream = (answer: (body: string) => Response): Upstream => {
    const seen: { url: string; body: string; headers: Headers }[] = [];
    return {
        seen,
        fetch: (async (input: string | URL | Request, init?: RequestInit) => {
            const body = init?.body === undefined || init.body === null ? "" : new TextDecoder().decode(init.body as Uint8Array);
            seen.push({ url: String(input), body, headers: new Headers(init?.headers) });
            return answer(body);
        }) as typeof fetch,
    };
};

const sse = (events: readonly { readonly event: string; readonly data: unknown }[]): Response =>
    new Response(events.map(({ event, data }) => `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`).join(""), {
        headers: { "content-type": "text/event-stream" },
    });

// A model answer that repeats the last token it was sent (the tool result's), as text and inside a tool call's input.
const echoTokens = (body: string): Response => {
    const token = [...body.matchAll(/⟦[A-Z_]+_\d+⟧/gu)].at(-1)?.[0] ?? "nothing";
    return sse([
        { event: "message_start", data: { type: "message_start", message: { id: "m", type: "message", role: "assistant", content: [] } } },
        { event: "content_block_start", data: { type: "content_block_start", index: 0, content_block: { type: "text", text: "" } } },
        {
            event: "content_block_delta",
            data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `Found ${token.slice(0, 5)}` } },
        },
        { event: "content_block_delta", data: { type: "content_block_delta", index: 0, delta: { type: "text_delta", text: `${token.slice(5)}.` } } },
        { event: "content_block_stop", data: { type: "content_block_stop", index: 0 } },
        {
            event: "content_block_start",
            data: { type: "content_block_start", index: 1, content_block: { type: "tool_use", id: "t", name: "Bash", input: {} } },
        },
        {
            event: "content_block_delta",
            data: {
                type: "content_block_delta",
                index: 1,
                delta: { type: "input_json_delta", partial_json: `{"command": "grep '${token}' people.csv"}` },
            },
        },
        { event: "content_block_stop", data: { type: "content_block_stop", index: 1 } },
        { event: "message_stop", data: { type: "message_stop" } },
    ]);
};

const request = (text: string) => ({
    model: "claude-opus-5",
    system: "You are a coding agent.",
    messages: [
        { role: "user", content: "Who is in the file?" },
        { role: "assistant", content: [{ type: "tool_use", id: "t0", name: "Bash", input: { command: "cat people.csv" } }] },
        { role: "user", content: [{ type: "tool_result", tool_use_id: "t0", content: text }] },
    ],
    stream: true,
});

const harness = async (policy: Partial<PrivacyShieldPolicy>, provider: string, answer: (body: string) => Response = echoTokens) => {
    const fake = privacySliceFake({ policy });
    const fakeUpstream = upstream(answer);
    const app = new Hono<AppEnv>();
    const warnings: string[] = [];
    app.all(
        "/privacy/gateway/:session/*",
        createGatewayRoute({ shield: fake.privacyShield, warn: (message) => warnings.push(message), fetch: fakeUpstream.fetch }),
    );
    const base = await fake.privacyShield.baseUrlFor({ provider, upstream: "https://api.anthropic.com", conversationId: "c-1" });
    const send = (path: string, body: unknown, headers: Record<string, string> = {}) =>
        app.request(`${new URL(base ?? "http://127.0.0.1:9/privacy/gateway/none").pathname}${path}`, {
            method: "POST",
            headers: { "content-type": "application/json", authorization: "Bearer sk-oauth", ...headers },
            body: JSON.stringify(body),
        });
    return { fake, provider: fakeUpstream, send, base, warnings };
};

// The concatenated text deltas and the tool input JSON, as a runtime assembles them.
const assembled = async (response: Response): Promise<{ text: string; input: string }> => {
    const raw = await response.text();
    let text = "";
    let input = "";
    for (const block of raw.split("\n\n")) {
        const data = block.split("\n").find((line) => line.startsWith("data: "));
        if (data === undefined) {
            continue;
        }
        const event = JSON.parse(data.slice(6)) as { type: string; delta?: { type: string; text?: string; partial_json?: string } };
        if (event.type === "content_block_delta" && event.delta?.type === "text_delta") {
            text += event.delta.text ?? "";
        }
        if (event.type === "content_block_delta" && event.delta?.type === "input_json_delta") {
            input += event.delta.partial_json ?? "";
        }
    }
    return { text, input };
};

describe("masking for an untrusted provider", () => {
    test("the provider reads tokens, the runtime gets the values back, and the log keeps kinds and counts only", async () => {
        const { fake, provider, send } = await harness({ mode: "on" }, "claude");
        const response = await send("/v1/messages?beta=true", request(`id|name|pesel\n1|${PERSON}|${PESEL}\n`));
        expect(response.status).toBe(200);
        const [sent] = provider.seen;
        expect(sent?.url).toBe("https://api.anthropic.com/v1/messages?beta=true");
        // The runtime's own credential travels as it came.
        expect(sent?.headers.get("authorization")).toBe("Bearer sk-oauth");
        expect(sent?.body).not.toContain(PESEL);
        expect(sent?.body).not.toContain(PERSON);
        expect(sent?.body).toContain("⟦NATIONAL_ID_1⟧");
        expect(sent?.body).toContain("brackets, label and number");
        // The note's own examples are no token anybody was given.
        expect(sent?.body).not.toMatch(/⟦PERSON_\d+⟧ or/u);
        const { text, input } = await assembled(response);
        expect(text).not.toContain("⟦");
        expect(JSON.parse(input)).toEqual({ command: expect.stringMatching(new RegExp(`grep '(${PERSON}|${PESEL})' people.csv`, "u")) as unknown });
        const [entry] = fake.privacyLedger.entries;
        expect(entry).toMatchObject({ provider: "claude", trusted: false, action: "masked", protocol: "anthropic", conversationId: "c-1" });
        expect(entry?.counts["national-id"]).toBe(1);
        expect(JSON.stringify(fake.privacyLedger.entries)).not.toContain(PESEL);
    });

    test("the same conversation masks to the same bytes on its next request, so the provider's cache holds", async () => {
        const { provider, send } = await harness({ mode: "on" }, "claude");
        await send("/v1/messages", request(`${PERSON}, PESEL ${PESEL}`));
        await send("/v1/messages", request(`${PERSON}, PESEL ${PESEL}`));
        expect(provider.seen[0]?.body).toBe(provider.seen[1]?.body);
    });

    test("a request on a path no walker knows is refused, not sent as it came", async () => {
        const { provider, send, fake } = await harness({ mode: "on" }, "claude");
        const response = await send("/v1/unknown", { text: `PESEL ${PESEL}` });
        expect(response.status).toBe(400);
        expect(provider.seen).toHaveLength(0);
        expect(fake.privacyLedger.entries[0]?.action).toBe("refused");
    });
});

describe("what passes untouched", () => {
    test("a trusted provider reads the request as it came", async () => {
        const { provider, send, fake } = await harness({ mode: "on", trusted: ["claude"] }, "claude");
        await send("/v1/messages", request(`${PERSON} ${PESEL}`));
        expect(provider.seen[0]?.body).toContain(PESEL);
        expect(fake.privacyLedger.entries[0]).toMatchObject({ action: "passed", trusted: true });
    });

    // The session carries its conversation, so a grant made for one reads the same here as at the turn's door.
    test("a provider trusted in this conversation alone reads it as it came, and is masked in any other", async () => {
        const grant = { mode: "on" as const, conversations: [{ conversationId: "c-1", provider: "claude" }] };
        const granted = await harness(grant, "claude");
        await granted.send("/v1/messages", request(`${PERSON} ${PESEL}`));
        expect(granted.provider.seen[0]?.body).toContain(PESEL);
        expect(granted.fake.privacyLedger.entries[0]).toMatchObject({ action: "passed", trusted: true, conversationId: "c-1" });
        const elsewhere = await harness({ mode: "on", conversations: [{ conversationId: "c-2", provider: "claude" }] }, "claude");
        await elsewhere.send("/v1/messages", request(`${PERSON} ${PESEL}`));
        expect(elsewhere.provider.seen[0]?.body).not.toContain(PESEL);
    });

    test("watching sends the request as it came and records what it would have masked", async () => {
        const { provider, send, fake } = await harness({ mode: "watch" }, "claude");
        await send("/v1/messages", request(`${PERSON} ${PESEL}`));
        expect(provider.seen[0]?.body).toContain(PESEL);
        expect(fake.privacyLedger.entries[0]).toMatchObject({ action: "watched", trusted: false });
        expect(fake.privacyLedger.entries[0]?.counts["national-id"]).toBe(1);
    });

    test("with the shield off no gateway address is handed out at all", async () => {
        const { base } = await harness({ mode: "off" }, "claude");
        expect(base).toBeUndefined();
    });
});

// A conversation in the tool-result clearing arm goes through the gateway with the shield off: its long requests reach
// the provider with the old results replaced, and nothing else about them changes or is logged.
describe("tool-result clearing", () => {
    // Thirty results of 5,000 tokens each: past the trigger, with ten behind the kept window, of which two whole chunks go.
    const longRequest = () => ({
        model: "claude-opus-5",
        messages: [
            { role: "user", content: "Read the logs." },
            ...Array.from({ length: 30 }, (_, index) => [
                { role: "assistant", content: [{ type: "tool_use", id: `t${index}`, name: "Bash", input: { command: `cat log-${index}` } }] },
                { role: "user", content: [{ type: "tool_result", tool_use_id: `t${index}`, content: `log ${index} `.padEnd(20_000, "x") }] },
            ]).flat(),
        ],
        stream: true,
    });
    const relay = async (clearing: boolean) => {
        const fake = privacySliceFake({ policy: { mode: "off" } });
        const provider = upstream(() => new Response("{}", { headers: { "content-type": "application/json" } }));
        const app = new Hono<AppEnv>();
        app.all("/privacy/gateway/:session/*", createGatewayRoute({ shield: fake.privacyShield, warn: () => undefined, fetch: provider.fetch }));
        const base = await fake.privacyShield.relayUrlFor({
            provider: "claude",
            upstream: "https://api.anthropic.com",
            conversationId: "c-1",
            clearing,
        });
        await app.request(`${new URL(base).pathname}/v1/messages`, {
            method: "POST",
            headers: { "content-type": "application/json" },
            body: JSON.stringify(longRequest()),
        });
        return { fake, sent: provider.seen[0]?.body ?? "" };
    };

    test("the clearing arm's long request reaches the provider with its oldest results replaced, and leaves no log line", async () => {
        const { fake, sent } = await relay(true);
        expect(sent.split(CLEARED_PLACEHOLDER).length - 1).toBe(8);
        expect(sent).not.toContain("log 0 ");
        expect(sent).toContain("log 8 ");
        expect(sent).toContain("log 29 ");
        expect(fake.privacyLedger.entries).toEqual([]);
    });

    test("a relay outside the arm sends the same request byte for byte", async () => {
        const { sent } = await relay(false);
        expect(sent).toBe(JSON.stringify(longRequest()));
    });
});

test("a session nobody signed reaches nothing", async () => {
    const fake = privacySliceFake({ policy: { mode: "on" } });
    const app = new Hono<AppEnv>();
    app.all("/privacy/gateway/:session/*", createGatewayRoute({ shield: fake.privacyShield, warn: () => undefined }));
    const response = await app.request("/privacy/gateway/forged.session/v1/messages", { method: "POST", body: "{}" });
    expect(response.status).toBe(404);
});
