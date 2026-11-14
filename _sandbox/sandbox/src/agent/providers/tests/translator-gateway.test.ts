import type { ProviderRefusal } from "@intentic/sandbox-contract/schemas/providers/plan-limits";
import { z } from "zod";
import { signedPayloads } from "../../../auth/signed-payload.js";
import type { RefusalAnswer } from "../../../usage/provider-refusals.js";
import { unstubbed } from "@intentic/testing";
import { Hono } from "hono";
import { pino } from "pino";
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

// `seed` is what the ledger holds before the first request; `covers` the gateway's reading of what an answer proves open.
interface HarnessOptions {
    readonly seed?: readonly ProviderRefusal[];
    readonly covers?: (provider: string, account: string, model: string) => Promise<(other: string) => boolean>;
    // The Google accounts connected, best first; two unless a test needs more.
    readonly accounts?: readonly string[];
}

const harness = (answer: (model: string | undefined) => Response, options: HarnessOptions = {}) => {
    const ledger = memoryProviderRefusalStore({ gemini: options.seed ?? [] });
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
        // The verdict's state lines are not what these tests read.
        logger: pino({ level: "silent" }),
        providerAccounts: async () => [],
        cliProxy: unstubbed<ServiceabilityDeps["cliProxy"]>("cliProxy", {
            accounts: async () => ({ codex: [], grok: [], kimi: [], gemini: (options.accounts ?? [A, B]).map((name) => ({ name, label: `${name}@example.com` })) }),
            accountPrefix: (name: string) => accountPrefix(name),
        }),
    });
    const upstream = translator(answer);
    const warned: string[] = [];
    const said: string[] = [];
    const gateway = createTranslatorGateway({
        translator: { url: "http://127.0.0.1:8789/", token: TOKEN },
        loopbackBase: LOOPBACK,
        sessions: translatorGatewaySessionsFrom(async () => KEY),
        candidates: (provider, model) => pinnedCandidates(deps, provider, model),
        refusals: providerRefusals,
        covers: options.covers,
        reread: (provider, account) => reread.push([provider, account]),
        logger: { info: (_fields: object, message?: string) => said.push(message ?? ""), warn: (_fields: object, message?: string) => warned.push(message ?? "") },
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
    return { ledger, settled, reread, warned, said, gateway, upstream, send };
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

// Google's answer when it is slowing requests down rather than refusing an allowance: the bare RESOURCE_EXHAUSTED, which
// names no reset, while the account's own reading shows most of its Gemini pool left.
const THROTTLE = { error: { code: 429, message: "Resource has been exhausted (e.g. check quota).", status: "RESOURCE_EXHAUSTED" } };
const throttle = (): Response => Response.json(THROTTLE, { status: 429, headers: { "x-upstream": "google" } });

// 2026-11-14: a throttle on Gemini 3.8 Flash was filed against all 31 Google accounts in turn, each re-read and answered
// by its own reading, about four hundred ready → spent → ready flips in an afternoon.
test("a throttle is filed against no account and re-reads none: the loop gets it back to retry", async () => {
    const { ledger, reread, settled, said, gateway, upstream, send } = harness(() => throttle());

    const response = await send("/v1/chat/completions", { body: chat });

    expect(response.status).toBe(429);
    expect(await response.json()).toStrictEqual(THROTTLE);
    // Another account may not be throttled, so the next one was asked too.
    expect(upstream.seen.map(({ model }) => model)).toStrictEqual([`${accountPrefix(A)}/${MODEL}`, `${accountPrefix(B)}/${MODEL}`]);
    expect(await filed(ledger)).toStrictEqual([]);
    expect(reread).toStrictEqual([]);
    expect(settled).toStrictEqual([]);
    expect(gateway.attributedAt("gemini", MODEL)).toBeUndefined();
    expect(gateway.throttledAt("gemini", MODEL)).toBeTypeOf("number");
    expect(said).toContain("translator gateway: the provider is throttling this model, not refusing an allowance; the loop retries on its own backoff");
});

test("a throttled request is asked of a few accounts, not the whole fleet", async () => {
    const accounts = ["a.json", "b.json", "c.json", "d.json", "e.json"];
    const { upstream, send } = harness(() => throttle(), { accounts });

    const response = await send("/v1/chat/completions", { body: chat });

    expect(response.status).toBe(429);
    expect(upstream.seen).toHaveLength(3);
});

test("an account throttled is passed for the next, and the answer settles nothing it did not refuse", async () => {
    const { ledger, reread, send } = harness((model) => (model === `${accountPrefix(A)}/${MODEL}` ? throttle() : sse()));

    const response = await send("/v1/chat/completions", { body: chat });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(STREAM);
    expect(await filed(ledger)).toStrictEqual([]);
    expect(reread).toStrictEqual([]);
});

// The translator answers for a credential it is resting on this model without asking the provider: that bench is on its
// listing of the account already (modelCooldowns), so nothing is filed, and resting accounts are not throttles to count.
test("the translator's own bench is moved past, filed nowhere", async () => {
    const bench = { error: { code: "model_cooldown", message: `All credentials for model ${MODEL} are cooling down`, reset_seconds: 40 } };
    const { ledger, reread, gateway, send } = harness((model) =>
        model === `${accountPrefix(A)}/${MODEL}` ? Response.json(bench, { status: 429 }) : sse(),
    );

    const response = await send("/v1/chat/completions", { body: chat });

    expect(response.status).toBe(200);
    expect(await filed(ledger)).toStrictEqual([]);
    expect(reread).toStrictEqual([]);
    expect(gateway.throttledAt("gemini", MODEL)).toBeUndefined();
});

// A provider that names a reset hours out has spent the allowance, whatever words it used.
test("a 429 naming a reset past a retry's is a spent allowance, filed with that reset", async () => {
    const spent = { error: { code: 429, message: "Too many requests.", reset_seconds: 3 * 3600 } };
    const { ledger, reread, send } = harness((model) => (model === `${accountPrefix(A)}/${MODEL}` ? Response.json(spent, { status: 429 }) : sse()));

    await (await send("/v1/chat/completions", { body: chat })).text();

    expect(await filed(ledger)).toMatchObject([{ kind: "limit", account: A, model: MODEL }]);
    expect(reread).toStrictEqual([["gemini", A]]);
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

// A spent allowance this gateway filed names its account, and only an answer pinned to that account settles it: a ChatGPT
// allowance OpenAI reset early read empty while every forced Codex send went through unpinned (2026-11-13).
const DAY_S = 24 * 3600;
const spentOn = (account: string, at: number, model: string = MODEL): ProviderRefusal => ({
    at,
    kind: "limit",
    message: "You've hit your usage limit.",
    account,
    model,
    resetsAt: Math.floor(Date.now() / 1000) + DAY_S,
});

test("every account reads spent: the one refused longest ago is still asked, and its answer settles its refusal", async () => {
    const now = Date.now();
    const { ledger, settled, upstream, send } = harness(() => sse(), { seed: [spentOn(A, now - 60_000), spentOn(B, now - 120_000)] });

    const response = await send("/v1/chat/completions", { body: chat });

    expect(response.status).toBe(200);
    expect(await response.text()).toBe(STREAM);
    expect(upstream.seen.map(({ model }) => model)).toStrictEqual([`${accountPrefix(B)}/${MODEL}`]);
    expect(settled).toStrictEqual([["gemini", { account: B, model: MODEL, askedAt: expect.any(Number) }]]);
    expect((await filed(ledger)).map((refusal) => refusal.account)).toStrictEqual([A]);
});

test("every account reads spent and is: each probe refuses, is filed again, and the loop gets the last refusal, never an unpinned retry", async () => {
    const now = Date.now();
    const { ledger, settled, upstream, send } = harness(() => quota(), { seed: [spentOn(A, now - 60_000), spentOn(B, now - 120_000)] });

    const response = await send("/v1/chat/completions", { body: chat });

    expect(response.status).toBe(429);
    expect(upstream.seen.map(({ model }) => model)).toStrictEqual([`${accountPrefix(B)}/${MODEL}`, `${accountPrefix(A)}/${MODEL}`]);
    expect((await filed(ledger)).every((refusal) => refusal.at >= now)).toBe(true);
    expect(settled).toStrictEqual([]);
});

test("an answer settles the account's refusal of every model it covers, and only that account's", async () => {
    const OTHER = "gemini-3.8-pro-high";
    const now = Date.now();
    const { ledger, send } = harness(() => sse(), {
        seed: [spentOn(A, now - 60_000, OTHER), spentOn(B, now - 60_000, OTHER)],
        covers: async (_provider, _account, model) => (other) => model === MODEL && other === OTHER,
    });

    const response = await send("/v1/chat/completions", { body: chat });
    expect(response.status).toBe(200);
    // Settled once the answer has come whole.
    expect(await response.text()).toBe(STREAM);

    // Answered on A, the first account with room for MODEL: B's refusal of the other model is still B's.
    expect((await filed(ledger)).map((refusal) => [refusal.account, refusal.model])).toStrictEqual([[B, OTHER]]);
});
