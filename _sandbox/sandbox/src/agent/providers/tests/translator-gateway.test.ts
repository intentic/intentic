import type { ProviderRefusal } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import { z } from "zod";
import { signedPayloads } from "../../../auth/signed-payload.js";
import type { RefusalAnswer } from "../../../usage/provider-refusals.js";
import { unstubbed } from "@intentic/testing";
import { Hono } from "hono";
import type { AppEnv } from "../../../app-env.js";
import { memoryProviderRefusalStore } from "../../../usage/provider-refusals.js";
import type { ServiceabilityDeps } from "../../../usage/serviceability/serviceability.js";
import { createTranslatorGateway, pinnedCandidates } from "../translator-gateway.js";
import { accountPrefix } from "../translator-prefixes.js";
import { translatorGatewaySessionsFrom } from "../translator-gateway-session.js";

// The gateway end to end over a stand-in translator: a request naming a model is placed on the best of the provider's
// accounts by its prefix, a spent allowance is filed under the account that gave it before the next is tried, and the
// answer that comes back whole settles that account. Ranking runs on the real verdict over an in-memory ledger, and every
// address is a real session signed under an in-memory key.

const TOKEN = "local-bearer";
const MODEL = "gemini-3.8-flash-high";
const A = "a.json";
const B = "b.json";
// Google's own body for a spent Antigravity allowance, as the translator hands it on.
const QUOTA = { error: { code: 429, message: "Individual quota reached. Please upgrade your subscription to increase your limits. Resets in 152h53m11s." } };
const QUOTA_SECONDS = 152 * 3600 + 53 * 60 + 11;
const STREAM = 'data: {"choices":[{"delta":{"content":"hello"}}]}\n\ndata: [DONE]\n\n';
const KEY = Buffer.alloc(32, 7);
const LOOPBACK = "http://127.0.0.1:7777";

const sse = (): Response => new Response(STREAM, { headers: { "content-type": "text/event-stream" } });
const quota = (): Response => Response.json(QUOTA, { status: 429, headers: { "x-upstream": "google" } });

interface Seen {
    readonly url: string;
    readonly model: string | undefined;
    readonly body: string;
    readonly headers: Headers;
}

// The translator, answering each request by the model it names.
const translator = (answer: (model: string | undefined) => Response) => {
    const seen: Seen[] = [];
    // SAFETY: the gateway calls fetch with a URL and an init alone, which is all this stand-in answers.
    const fetchFn = (async (input: string | URL | Request, init?: RequestInit) => {
        const body = init?.body instanceof Uint8Array ? new TextDecoder().decode(init.body) : "";
        // SAFETY: every body these tests send is a JSON object, or nothing.
        const model = body === "" ? undefined : (JSON.parse(body) as { readonly model?: string }).model;
        seen.push({ url: String(input), model, body, headers: new Headers(init?.headers) });
        return answer(model);
    }) as typeof fetch;
    return { seen, fetchFn };
};

const harness = (answer: (model: string | undefined) => Response) => {
    const ledger = memoryProviderRefusalStore();
    const settled: [string, RefusalAnswer][] = [];
    const reread: [string, string][] = [];
    const providerRefusals = {
        ...ledger,
        settle: async (provider: string, settledAnswer: RefusalAnswer) => {
            settled.push([provider, settledAnswer]);
            await ledger.settle(provider, settledAnswer);
        },
    };
    // Two Google accounts with nothing known against either, each known to the translator by its prefix.
    const deps = unstubbed<ServiceabilityDeps>("services", {
        providerRefusals,
        providerAccounts: async () => [],
        cliProxy: unstubbed<ServiceabilityDeps["cliProxy"]>("cliProxy", {
            accounts: async () => ({ codex: [], grok: [], kimi: [], gemini: [{ name: A, label: "a@example.com" }, { name: B, label: "b@example.com" }] }),
            accountPrefix: (name: string) => accountPrefix(name),
        }),
    });
    const upstream = translator(answer);
    const warned: string[] = [];
    const gateway = createTranslatorGateway({
        translator: { url: "http://127.0.0.1:8789/", token: TOKEN },
        loopbackBase: LOOPBACK,
        sessions: translatorGatewaySessionsFrom(async () => KEY),
        candidates: (provider, model) => pinnedCandidates(deps, provider, model),
        refusals: providerRefusals,
        reread: (provider, account) => reread.push([provider, account]),
        logger: { info: () => undefined, warn: (_fields: object, message?: string) => warned.push(message ?? "") },
        fetch: upstream.fetchFn,
    });
    const app = new Hono<AppEnv>();
    app.all("/translator-gateway/:session/*", gateway.route);
    // `path` is what follows the provider's own address, as a loop configured with it would ask; `session` replaces it.
    const send = async (
        path: string,
        init: { readonly body?: object; readonly headers?: Record<string, string>; readonly method?: string; readonly session?: string } = {},
    ) => {
        const base = init.session ?? new URL(await gateway.baseUrlFor("gemini")).pathname.split("/").at(-1) ?? "";
        const request: RequestInit = {
            method: init.method ?? "POST",
            headers: { "content-type": "application/json", authorization: `Bearer ${TOKEN}`, ...init.headers },
        };
        if (init.body !== undefined) {
            request.body = JSON.stringify(init.body);
        }
        return app.request(`/translator-gateway/${base}${path}`, request);
    };
    return { ledger, settled, reread, warned, gateway, upstream, send };
};

const chat = { model: MODEL, stream: true, messages: [{ role: "user", content: "hi" }] };
const filed = async (ledger: ReturnType<typeof memoryProviderRefusalStore>): Promise<readonly ProviderRefusal[]> => (await ledger.onFile())["gemini"] ?? [];

test("a spent account is filed under its own name, and the request is answered by the next", async () => {
    const { ledger, settled, reread, gateway, upstream, send } = harness((model) => (model === `${accountPrefix(A)}/${MODEL}` ? quota() : sse()));

    const response = await send("/v1/chat/completions", { body: chat });

    expect(response.status).toBe(200);
    expect(response.headers.get("content-type")).toBe("text/event-stream");
    expect(await response.text()).toBe(STREAM);
    // Each account asked for by its own prefix, best first, on the translator's own path, with the loop's own bearer.
    expect(upstream.seen.map(({ url, model }) => [url, model])).toStrictEqual([
        ["http://127.0.0.1:8789/v1/chat/completions", `${accountPrefix(A)}/${MODEL}`],
        ["http://127.0.0.1:8789/v1/chat/completions", `${accountPrefix(B)}/${MODEL}`],
    ]);
    expect(upstream.seen[0]?.headers.get("authorization")).toBe(`Bearer ${TOKEN}`);
    expect(upstream.seen[0]?.headers.get("accept-encoding")).toBe("identity");
    // The rest of the body goes as it came.
    expect(JSON.parse(upstream.seen[1]?.body ?? "{}")).toStrictEqual({ ...chat, model: `${accountPrefix(B)}/${MODEL}` });

    const refusals = await filed(ledger);
    expect(refusals).toHaveLength(1);
    expect(refusals[0]).toMatchObject({ kind: "limit", account: A, model: MODEL, message: QUOTA.error.message });
    expect(Math.abs((refusals[0]?.resetsAt ?? 0) - (Date.now() / 1000 + QUOTA_SECONDS))).toBeLessThan(5);
    expect(refusals.filter((refusal) => refusal.account === undefined)).toStrictEqual([]);
    expect(reread).toStrictEqual([["gemini", A]]);
    expect(gateway.attributedAt("gemini", MODEL)).toBe(refusals[0]?.at);
    // The answer came whole, so it settles what the account that gave it had refused of the model.
    expect(settled).toStrictEqual([["gemini", { account: B, model: MODEL, askedAt: expect.any(Number) }]]);
});

test("every account refused: the loop gets the last refusal exactly as it came, and each is filed under its own name", async () => {
    const { ledger, settled, send } = harness(() => quota());

    const response = await send("/v1/chat/completions", { body: chat });

    expect(response.status).toBe(429);
    expect(response.headers.get("x-upstream")).toBe("google");
    expect(await response.json()).toStrictEqual(QUOTA);
    expect((await filed(ledger)).map((refusal) => refusal.account).toSorted()).toStrictEqual([A, B]);
    expect(settled).toStrictEqual([]);
});

test("an address minted for a provider is the gateway's own, on the loopback, and names only that provider", async () => {
    const { gateway } = harness(() => sse());
    const base = await gateway.baseUrlFor("codex");
    expect(base.startsWith(`${LOOPBACK}/translator-gateway/`)).toBe(true);
    expect(await translatorGatewaySessionsFrom(async () => KEY).verify(base.split("/").at(-1) ?? "")).toBe("codex");
});

// The bearer is a constant every image bakes in, and this door is on the server the public address reaches: an address
// this daemon did not sign is answered as no address, bearer or not.
test("the bearer with no session, a forged one, or one for a provider with nothing behind it is answered as no address", async () => {
    const { upstream, send } = harness(() => sse());
    const elsewhere = await translatorGatewaySessionsFrom(async () => Buffer.alloc(32, 9)).sign("gemini");
    const claude = await signedPayloads(async () => KEY, z.object({ p: z.string() }), { domain: "translator-gateway:" }).sign({ p: "claude" });
    const undomained = await signedPayloads(async () => KEY, z.object({ p: z.string() })).sign({ p: "gemini" });

    for (const session of ["nothing", elsewhere, claude, undomained]) {
        const response = await send("/v1/chat/completions", { body: chat, session });
        expect(response.status).toBe(404);
    }
    expect(upstream.seen).toStrictEqual([]);
});

test("a request without the translator's bearer is turned away before anything reaches it", async () => {
    const { upstream, send } = harness(() => sse());

    expect((await send("/v1/chat/completions", { body: chat, headers: { authorization: "Bearer someone-else" } })).status).toBe(401);
    expect((await send("/v1/chat/completions", { body: chat, headers: { authorization: "" } })).status).toBe(401);
    expect(upstream.seen).toStrictEqual([]);
});

test("a request naming no model goes through unpinned", async () => {
    const { ledger, settled, upstream, send } = harness(() => sse());
    const unnamed = { messages: [{ role: "user", content: "hi" }] };

    expect((await send("/v1/chat/completions", { body: unnamed })).status).toBe(200);
    expect((await send("/v1/models", { method: "GET" })).status).toBe(200);

    expect(upstream.seen.map(({ url, body }) => [url, body])).toStrictEqual([
        ["http://127.0.0.1:8789/v1/chat/completions", JSON.stringify(unnamed)],
        ["http://127.0.0.1:8789/v1/models", ""],
    ]);
    expect(await filed(ledger)).toStrictEqual([]);
    expect(settled).toStrictEqual([]);
});

test("a prefix the translator does not route yet sends the request unpinned rather than failing it", async () => {
    const unknownModel = (model: string | undefined): Response =>
        Response.json({ error: { message: `unknown provider for model ${model ?? ""}`, type: "invalid_request_error", code: "model_not_found" } }, { status: 400 });
    const { ledger, upstream, send } = harness((model) => (model === MODEL ? sse() : unknownModel(model)));

    const response = await send("/v1/chat/completions", { body: chat });

    expect(response.status).toBe(200);
    expect(upstream.seen.map(({ model }) => model)).toStrictEqual([`${accountPrefix(A)}/${MODEL}`, `${accountPrefix(B)}/${MODEL}`, MODEL]);
    expect(await filed(ledger)).toStrictEqual([]);
});
