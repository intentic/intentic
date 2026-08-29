import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@intentic-app/prisma";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { configSchema, type Config } from "../config.js";
import { createTrialPool } from "./trial-pool.js";

/* THE TRIAL IS THE ONE ROUTE FAMILY THAT SPENDS INTENTIC'S OWN MONEY, so the things worth pinning here are the
 * ones that cost something when they break: the allowance actually stopping a caller, a refused key moving to
 * the next one instead of surfacing, and a turn nobody served not being billed. */

const logger = { child: () => logger, info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;

const baseConfig = configSchema.parse({
    database: { url: `postgres://x`, poolMax: 10 },
    betterAuth: { secret: `s` },
    secrets: { key: `` },
    webOrigin: `https://app.test`,
    google: { clientId: ``, clientSecret: `` },
    email: { apiKey: ``, from: `` },
    intenticCloudflare: { apiToken: ``, zone: `intentic.dev`, reapDryRun: `true` },
    zrok: { apiEndpoint: `https://zrok2.sbx.test`, agentEndpoint: ``, adminToken: `hub-admin`, zone: `sbx.test` },
    trial: { keys: `k1,k2`, baseUrl: `https://upstream.test/v1beta/openai`, models: ``, dailyMessages: 2 },
    api: { url: `http://localhost:6480`, port: 6480, host: `127.0.0.1`, httpsKey: ``, httpsCert: `` },
    log: { level: `silent`, pretty: `false` },
});

const configWith = (trial: Partial<Config["trial"]>): Config => ({ ...baseConfig, trial: { ...baseConfig.trial, ...trial } });

// The digest the routes look a connect token up by: the same one /sandbox/announce uses.
const digestOf = (token: string) => createHash(`sha256`).update(token).digest(`hex`);

interface Counters {
    readonly used?: number;
}

const fakePrisma = ({ used }: Counters = {}) => {
    let messages = used ?? 0;
    let lastModel: string | null = null;
    const trialUsage = {
        findUnique: vi.fn(async () => (messages === 0 && lastModel === null ? null : { messages, lastModel })),
        upsert: vi.fn(async () => {
            messages += 1;
            return { messages, lastModel };
        }),
        // One `update` serves two callers: the refund decrements, and the served-model record writes a name.
        // Branching on the payload rather than counting calls, so a test cannot pass by doing the wrong write.
        update: vi.fn(async ({ data }: { data: { lastModel?: string } }) => {
            if (typeof data.lastModel === `string`) {
                lastModel = data.lastModel;
                return { messages, lastModel };
            }
            messages -= 1;
            return { messages, lastModel };
        }),
        updateMany: vi.fn(async () => ({ count: 0 })),
    };
    const prisma = {
        sandbox: {
            findUnique: vi.fn(async ({ where }: { where: { tokenDigest: string } }) =>
                where.tokenDigest === digestOf(`tok`) ? { ownerId: `user-1` } : null,
            ),
        },
        trialUsage,
    };
    return { prisma: prisma as unknown as PrismaClient, trialUsage, spent: () => messages };
};

const call = (config: Config, prisma: PrismaClient, path: string, init?: RequestInit) =>
    createApp(config, prisma, logger).app.request(path, {
        ...init,
        headers: { authorization: `Bearer tok`, "content-type": `application/json`, ...init?.headers },
    });

const chat = (config: Config, prisma: PrismaClient) => call(config, prisma, `/trial/v1/chat/completions`, { method: `POST`, body: `{"model":"m"}` });

describe("the free trial", () => {
    it("is closed entirely when the platform holds no keys", async () => {
        const { prisma } = fakePrisma();
        const response = await call(configWith({ keys: `` }), prisma, `/trial/status`);

        // 404, not 401: a platform that runs no trial has nothing here, and saying so is not an invitation to
        // keep guessing tokens.
        expect(response.status).toBe(404);
    });

    it("refuses a token that belongs to no sandbox", async () => {
        const { prisma } = fakePrisma();
        const response = await call(baseConfig, prisma, `/trial/status`, { headers: { authorization: `Bearer nope` } });

        expect(response.status).toBe(404);
    });

    it("reports a full allowance to an account that has never used it", async () => {
        const { prisma } = fakePrisma();
        const response = await call(baseConfig, prisma, `/trial/status`);

        expect(response.status).toBe(200);
        expect(await response.json()).toMatchObject({ allowance: 2, used: 0, remaining: 2, health: `unknown` });
    });

    it("spends one message per turn and passes the upstream answer straight through", async () => {
        const { prisma, spent } = fakePrisma();
        const fetchFn = vi.fn(async () => new Response(`{"choices":[]}`, { status: 200, headers: { "content-type": `application/json` } }));
        vi.stubGlobal(`fetch`, fetchFn);

        const response = await chat(baseConfig, prisma);

        expect(response.status).toBe(200);
        expect(await response.text()).toBe(`{"choices":[]}`);
        expect(spent()).toBe(1);
        vi.unstubAllGlobals();
    });

    it("refuses once the day's allowance is gone, and names the way forward", async () => {
        // Two of two already spent; this is the third attempt.
        const { prisma } = fakePrisma({ used: 2 });
        const fetchFn = vi.fn(async () => new Response(`{}`, { status: 200 }));
        vi.stubGlobal(`fetch`, fetchFn);

        const response = await chat(baseConfig, prisma);

        expect(response.status).toBe(429);
        const body = (await response.json()) as { error: { type: string; message: string } };
        expect(body.error.type).toBe(`trial_exhausted`);
        // The wall is not the whole message: the free Google sign-in is the next rung and the copy says so.
        expect(body.error.message).toContain(`Google`);
        // Nothing was sent upstream: a refused turn must not spend the pool as well as the allowance.
        expect(fetchFn).not.toHaveBeenCalled();
        vi.unstubAllGlobals();
    });

    /* Only the chat POSTs are the subject here: the ladder reads the upstream's capability listing with a GET on
     * the same pool, so a stub that answers by call ORDER would be describing that read instead. */
    const chatPosts = (fetchFn: ReturnType<typeof vi.fn>) =>
        fetchFn.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === `POST`);

    it("moves to the next key when one is rate-limited, rather than surfacing the refusal", async () => {
        const { prisma } = fakePrisma();
        let posts = 0;
        const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
            if (init?.method !== `POST`) {
                return new Response(`{}`, { status: 503 });
            }
            posts += 1;
            return posts === 1
                ? new Response(`{"error":"quota"}`, { status: 429 })
                : new Response(`{"choices":[1]}`, { status: 200, headers: { "content-type": `application/json` } });
        });
        vi.stubGlobal(`fetch`, fetchFn);

        const response = await chat(baseConfig, prisma);

        expect(response.status).toBe(200);
        expect(await response.text()).toBe(`{"choices":[1]}`);
        // The SECOND key on the SAME model: a refused key is what failover is for, and reaching for the next
        // model instead would spend the ladder on a problem the ladder is not about.
        expect(chatPosts(fetchFn)).toHaveLength(2);
        expect(chatPosts(fetchFn).every(([, init]) => JSON.parse(String((init as RequestInit).body)).model === `gemini-flash-latest`)).toBe(true);
        vi.unstubAllGlobals();
    });

    it("gives the message back when no key could serve it on any model", async () => {
        const { prisma, spent } = fakePrisma();
        const fetchFn = vi.fn(async () => new Response(`{}`, { status: 503 }));
        vi.stubGlobal(`fetch`, fetchFn);

        const response = await chat(baseConfig, prisma);

        expect(response.status).toBe(502);
        // Every rung of the ladder against every key (two models, two keys) before anyone is told no. The user
        // is not billed for a turn nobody served, and not billed once per rung either.
        expect(chatPosts(fetchFn)).toHaveLength(4);
        expect(spent()).toBe(0);
        vi.unstubAllGlobals();
    });

    it("gives the message back when upstream rejects the model or request", async () => {
        const { prisma, spent } = fakePrisma();
        const fetchFn = vi.fn(async () => new Response(`{"error":{"message":"model not supported"}}`, { status: 404 }));
        vi.stubGlobal(`fetch`, fetchFn);

        const response = await chat(baseConfig, prisma);

        // Preserve the actionable upstream response, but do not charge for a completion that never happened.
        expect(response.status).toBe(404);
        expect(await response.text()).toContain(`model not supported`);
        expect(spent()).toBe(0);
        vi.unstubAllGlobals();
    });

    it("publishes service health from real chat traffic", async () => {
        const { prisma } = fakePrisma();
        vi.stubGlobal(
            `fetch`,
            vi.fn(async () => new Response(`{}`, { status: 503 })),
        );
        const app = createApp(baseConfig, prisma, logger).app;
        const headers = { authorization: `Bearer tok`, "content-type": `application/json` };

        const failed = await app.request(`/trial/v1/chat/completions`, { method: `POST`, headers, body: `{"model":"m"}` });
        const status = await app.request(`/trial/status`, { headers });

        expect(failed.status).toBe(502);
        expect(await status.json()).toMatchObject({ health: `unavailable`, retryAt: expect.any(String) });
        vi.unstubAllGlobals();
    });

    it("refunds, and does not repeat Google's billing advice, when the whole pool is rate-limited", async () => {
        const { prisma, spent } = fakePrisma();
        const fetchFn = vi.fn(async () => new Response(`{"error":{"message":"check your plan and billing details"}}`, { status: 429 }));
        vi.stubGlobal(`fetch`, fetchFn);

        const response = await chat(baseConfig, prisma);

        // The ceiling is intentic's, not the reader's: they hold no plan with Google and never asked for one.
        expect(response.status).toBe(502);
        expect(await response.text()).not.toContain(`billing`);
        // And an allowance that keeps counting down through turns nobody served is not an allowance.
        expect(chatPosts(fetchFn)).toHaveLength(4);
        expect(spent()).toBe(0);
        vi.unstubAllGlobals();
    });

    /* The two listing surfaces the ladder reads, stubbed apart: the compatibility shim's `/v1beta/openai/models`
     * (ids only) and Google's own `/v1beta/models` beside it (ids plus what each can be asked to do). Chat POSTs
     * fall through to a plain success, so one stub covers a whole route. */
    const upstream = (generateContent: readonly string[]) =>
        vi.fn(async (url: string, init?: RequestInit) => {
            if (init?.method === `POST`) {
                return new Response(`{"choices":[]}`, { status: 200, headers: { "content-type": `application/json` } });
            }
            return new Response(
                JSON.stringify({
                    models: generateContent.map((id) => ({ name: `models/${id}`, supportedGenerationMethods: [`generateContent`] })),
                }),
                { status: 200, headers: { "content-type": `application/json` } },
            );
        });

    /* THE CATALOG IS A CONSTANT, and this is the test that says so in every direction at once.
     *
     * A fresh Google key lists ~54 models. Many of them declare `generateContent` and still cannot serve an
     * agent turn: deep-research wants another API, gemma has no tool calling, lyria writes music, so the old
     * capability filter passed them through and the id-derived ordering put them FIRST, which is the model a
     * fresh conversation sends its opening message to. Publishing one synthetic id is what makes that
     * unreachable: there is nothing to rank and nothing to get wrong. */
    it("publishes exactly one model, whatever the upstream lists", async () => {
        const { prisma } = fakePrisma();
        vi.stubGlobal(
            `fetch`,
            upstream([`antigravity-preview-05-2026`, `deep-research-pro-preview-12`, `gemma-4-26b-a4b-it`, `gemini-flash-latest`]),
        );

        const response = await call(configWith({ models: `` }), prisma, `/trial/v1/models`);

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
            object: `list`,
            data: [{ id: `auto`, object: `model`, owned_by: `intentic-trial`, display_name: `Free trial` }],
        });
        vi.unstubAllGlobals();
    });

    /* The other half of the same guarantee, and the one that produced the error people reported. The sandbox's
     * translator writes its routing table from this catalog at boot; the picker re-reads it every minute. A
     * catalog that MOVES between those two reads offers a row the translator will refuse with "unknown provider
     * for model". A constant cannot move: including when the upstream has gone dark entirely, which used to be
     * its own separate rung of fallback logic. */
    it("publishes the same one model when the upstream cannot be read at all", async () => {
        const { prisma } = fakePrisma();
        vi.stubGlobal(
            `fetch`,
            vi.fn(async () => new Response(`{}`, { status: 503 })),
        );

        const response = await call(configWith({ models: `` }), prisma, `/trial/v1/models`);

        // NOT a 502, and not an empty list: what this trial offers is no longer a question the upstream answers.
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
            object: `list`,
            data: [{ id: `auto`, object: `model`, owned_by: `intentic-trial`, display_name: `Free trial` }],
        });
        vi.unstubAllGlobals();
    });

    /* WHAT THE PUBLISHED ID IS NOT: the thing sent upstream. The caller addresses `auto`, and the model actually
     * asked to answer is the ladder's first healthy rung, which is the whole trick, since Google has never
     * heard of `auto` and would refuse it. */
    it("sends a real model upstream, never the id the caller asked for", async () => {
        const { prisma } = fakePrisma();
        const fetchFn = upstream([`gemini-flash-latest`, `gemini-flash-lite-latest`]);
        vi.stubGlobal(`fetch`, fetchFn);

        const response = await call(baseConfig, prisma, `/trial/v1/chat/completions`, { method: `POST`, body: `{"model":"auto","stream":true}` });

        expect(response.status).toBe(200);
        const sent = fetchFn.mock.calls.find(([, init]) => init?.method === `POST`)?.[1];
        expect(JSON.parse(String(sent?.body))).toEqual({ model: `gemini-flash-latest`, stream: true });
        // And the answer says which one ran, because a routed trial the user cannot see into is a black box.
        expect(response.headers.get(`x-intentic-trial-model`)).toBe(`gemini-flash-latest`);
        vi.unstubAllGlobals();
    });

    /* THE REASON THE LADDER EXISTS. Google meters each model separately, so a Flash quota window that has closed
     * says nothing about Lite, and on a shared pool Flash closes often. The user's message must survive that,
     * which means the second rung is tried before anyone is told no. */
    it("falls to the next model when the first is out of quota on every key", async () => {
        const { prisma, spent } = fakePrisma();
        const asked: string[] = [];
        const fetchFn = vi.fn(async (_url: string, init?: RequestInit) => {
            if (init?.method !== `POST`) {
                return new Response(
                    JSON.stringify({
                        models: [`gemini-flash-latest`, `gemini-flash-lite-latest`].map((id) => ({
                            name: `models/${id}`,
                            supportedGenerationMethods: [`generateContent`],
                        })),
                    }),
                    { status: 200, headers: { "content-type": `application/json` } },
                );
            }
            const model = (JSON.parse(String(init.body)) as { model: string }).model;
            asked.push(model);
            return model === `gemini-flash-latest`
                ? new Response(`{"error":"quota"}`, { status: 429 })
                : new Response(`{"choices":[]}`, { status: 200, headers: { "content-type": `application/json` } });
        });
        vi.stubGlobal(`fetch`, fetchFn);

        const response = await chat(baseConfig, prisma);

        expect(response.status).toBe(200);
        // Both keys tried on the exhausted model, then the next rung, not a key sidelined for a model's quota.
        expect(asked).toEqual([`gemini-flash-latest`, `gemini-flash-latest`, `gemini-flash-lite-latest`]);
        expect(response.headers.get(`x-intentic-trial-model`)).toBe(`gemini-flash-lite-latest`);
        // The user got their message, so it is theirs to pay for: once, not once per rung tried.
        expect(spent()).toBe(1);
        vi.unstubAllGlobals();
    });

    /* DISCOVERY IS A VETO, NOT A SOURCE: the half of the bargain that keeps the curated ladder honest.
     *
     * It may only REMOVE rungs we named, never add ones we did not: a model the upstream has retired stops being
     * spent on without a release, while a family we have never vetted cannot reach a user by turning up in a
     * catalog. That asymmetry is the whole reason the picker is trustworthy again. */
    it("stops routing to a rung the upstream has retired", async () => {
        const { prisma } = fakePrisma();
        // Flash is gone from the listing; only Lite is left of the ladder.
        const fetchFn = upstream([`gemini-flash-lite-latest`, `deep-research-max-preview-01`]);
        vi.stubGlobal(`fetch`, fetchFn);

        // ONE app across both messages, because the ladder's cache belongs to the route instance: a fresh
        // `createApp` per request would be two cold starts and would never exercise the veto at all.
        const app = createApp(baseConfig, prisma, logger).app;
        const headers = { authorization: `Bearer tok`, "content-type": `application/json` };
        const send = () => app.request(`/trial/v1/chat/completions`, { method: `POST`, headers, body: `{"model":"auto"}` });

        // The first message answers from the ladder as written and starts the capability read behind itself:
        // the read is deliberately never on a user's critical path (trial-ladder.ts), so the veto lands next.
        await send();
        await vi.waitFor(() => expect(fetchFn.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method !== `POST`)).toBe(true));
        const before = chatPosts(fetchFn).length;
        const response = await send();

        expect(response.status).toBe(200);
        // The surviving rung, and NOT the chat-capable model we never chose: an id we did not vet is not a
        // candidate however loudly the upstream declares it can generate.
        expect(
            chatPosts(fetchFn)
                .slice(before)
                .map(([, init]) => JSON.parse(String((init as RequestInit).body)).model),
        ).toEqual([`gemini-flash-lite-latest`]);
        vi.unstubAllGlobals();
    });

    // The operator's list replaces the curated ladder wholesale: it is how a platform pointed at a non-Google
    // upstream names ids we have never heard of, so it cannot be filtered against Google's own vocabulary.
    it("routes to the operator's models when TRIAL_MODELS names some", async () => {
        const { prisma } = fakePrisma();
        const fetchFn = upstream([`gemini-flash-latest`]);
        vi.stubGlobal(`fetch`, fetchFn);

        const response = await call(configWith({ models: `my-own-model` }), prisma, `/trial/v1/chat/completions`, {
            method: `POST`,
            body: `{"model":"auto"}`,
        });

        expect(response.status).toBe(200);
        const sent = fetchFn.mock.calls.find(([, init]) => init?.method === `POST`)?.[1];
        expect(JSON.parse(String(sent?.body))).toEqual({ model: `my-own-model` });
        vi.unstubAllGlobals();
    });

    /* The line an operator was handed to paste, pasted whole. It reached a deployment exactly like this and the
     * picker offered its trailing note as the model, so what is pinned is that the note is not a model id, and
     * that a setting which is nothing but a comment means what a blank one means. */
    it("reads a pasted `#` note as the blank setting it annotates, not as a model", async () => {
        const { prisma } = fakePrisma();
        const fetchFn = upstream([`gemini-flash-latest`]);
        vi.stubGlobal(`fetch`, fetchFn);

        const models = `# optional allowlist; empty = whatever upstream serves`;
        const response = await call(configWith({ models }), prisma, `/trial/v1/chat/completions`, { method: `POST`, body: `{"model":"auto"}` });

        expect(response.status).toBe(200);
        const sent = fetchFn.mock.calls.find(([, init]) => init?.method === `POST`)?.[1];
        // The curated ladder, not the comment, which no upstream would have answered for.
        expect(JSON.parse(String(sent?.body))).toEqual({ model: `gemini-flash-latest` });
        vi.unstubAllGlobals();
    });

    /* Which model answered is recorded where the daemon can read it back. It cannot ride the response: the
     * sandbox's translator sits between us and does not forward headers, so the status poll the client already
     * makes when a turn settles is the channel. */
    it("remembers which model served, and reports it on the status read", async () => {
        const { prisma } = fakePrisma();
        vi.stubGlobal(`fetch`, upstream([`gemini-flash-latest`]));

        await chat(baseConfig, prisma);
        const status = await call(baseConfig, prisma, `/trial/status`);

        expect(await status.json()).toMatchObject({ servedModel: `gemini-flash-latest` });
        vi.unstubAllGlobals();
    });

    /* The same paste on the setting above it, where it costs more: a note glued to the last key makes that key
     * a credential no upstream knows. One key here, so the answer cannot depend on where the pool's rotating
     * cursor happened to start. */
    it("keeps a key a pasted note was glued to", async () => {
        const { prisma } = fakePrisma();
        const fetchFn = vi.fn(async (_url: string, init: RequestInit) =>
            (init.headers as Record<string, string>)[`authorization`] === `Bearer k1`
                ? new Response(`{}`, { status: 200, headers: { "content-type": `application/json` } })
                : new Response(`{"error":"invalid api key"}`, { status: 401, headers: { "content-type": `application/json` } }),
        );
        vi.stubGlobal(`fetch`, fetchFn);

        const config = configWith({ keys: `k1   # comma-separated Google AI Studio keys; empty = no trial at all` });
        const response = await chat(config, prisma);

        expect(response.status).toBe(200);
        vi.unstubAllGlobals();
    });
});

describe("the free-trial key pool", () => {
    it("reports healthy when the first selected key answers", async () => {
        const pool = createTrialPool(baseConfig, vi.fn(async () => new Response(`{}`, { status: 200 })) as unknown as typeof fetch);

        await pool.call(`/chat/completions`, { method: `POST`, observeHealth: true });

        expect(pool.status()).toEqual({ health: `healthy` });
    });

    it("times out a stuck key and advances to the next one", async () => {
        vi.useFakeTimers();
        try {
            const fetchFn = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
                const auth = (init?.headers as Record<string, string> | undefined)?.[`authorization`];
                return auth === `Bearer k1` ? new Promise<Response>(() => {}) : Promise.resolve(new Response(`{"choices":[1]}`, { status: 200 }));
            });
            const pool = createTrialPool(baseConfig, fetchFn as unknown as typeof fetch);
            const pending = pool.call(`/chat/completions`, { method: `POST`, body: () => `{}`, observeHealth: true });

            await vi.advanceTimersByTimeAsync(20_000);

            expect((await pending)?.response.status).toBe(200);
            expect(fetchFn).toHaveBeenCalledTimes(2);
            expect(pool.status().health).toBe(`degraded`);
        } finally {
            vi.useRealTimers();
        }
    });

    it("fails over on a rejected key and quarantines it for later calls", async () => {
        const auths: (string | undefined)[] = [];
        const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
            const auth = (init?.headers as Record<string, string> | undefined)?.[`authorization`];
            auths.push(auth);
            return new Response(`{}`, { status: auth === `Bearer k1` ? 401 : 200 });
        });
        const pool = createTrialPool(baseConfig, fetchFn as unknown as typeof fetch);

        expect((await pool.call(`/chat/completions`, { method: `POST`, observeHealth: true }))?.response.status).toBe(200);
        await pool.call(`/chat/completions`, { method: `POST`, observeHealth: true });
        await pool.call(`/chat/completions`, { method: `POST`, observeHealth: true });

        // The third rotation would start on k1 again; quarantine skips it and goes straight to the good key.
        expect(auths).toEqual([`Bearer k1`, `Bearer k2`, `Bearer k2`, `Bearer k2`]);
        expect(pool.status().health).toBe(`degraded`);
    });

    /* A QUOTA IS ABOUT A MODEL, NOT A KEY, and reading it as a key fact is what would break the ladder.
     *
     * Google meters each model separately per project. If a 429 on Flash sidelined the whole key, the fallback
     * rung would have no credential left to try, and since every key in a shared pool runs out of Flash at
     * about the same time, the pool would go dark at exactly the moment the ladder existed to save it. */
    it("keeps a key usable for another model after one model's quota refuses it", async () => {
        const attempts: { key: string; model: string }[] = [];
        const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
            const key = ((init?.headers ?? {}) as Record<string, string>)[`authorization`] ?? ``;
            const model = (JSON.parse(String(init?.body)) as { model: string }).model;
            attempts.push({ key, model });
            return new Response(`{}`, { status: model === `flash` ? 429 : 200 });
        });
        const pool = createTrialPool(baseConfig, fetchFn as unknown as typeof fetch);

        const attempt = await pool.call(`/chat/completions`, {
            method: `POST`,
            models: [`flash`, `lite`],
            body: (model) => JSON.stringify({ model }),
        });

        expect(attempt?.response.status).toBe(200);
        // Both keys refused on `flash`; the SAME keys are still reached for `lite`, and the first one answers.
        expect(attempts).toEqual([
            { key: `Bearer k1`, model: `flash` },
            { key: `Bearer k2`, model: `flash` },
            { key: `Bearer k1`, model: `lite` },
        ]);
        expect(attempt?.model).toBe(`lite`);
    });

    /* THE OUTAGE THIS PAIR OF TESTS IS ABOUT: the preferred rung stopped answering upstream, holding every
     * connection open instead of refusing, and the walk spent its entire clock discovering that on key after
     * key. The fallback rung was answering in under a second the whole time and was never reached, so a trial
     * with a healthy model and allowance to spare told every user it was unavailable. */
    it("abandons a silent rung for the fallback instead of timing out on every key", async () => {
        vi.useFakeTimers();
        try {
            const attempts: string[] = [];
            const fetchFn = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
                const model = (JSON.parse(String(init?.body)) as { model: string }).model;
                attempts.push(model);
                // Silence, not a refusal: the condition a per-key walk cannot tell apart from a slow answer.
                return model === `flash` ? new Promise<Response>(() => {}) : Promise.resolve(new Response(`{"choices":[1]}`, { status: 200 }));
            });
            const pool = createTrialPool(baseConfig, fetchFn as unknown as typeof fetch);
            const pending = pool.call(`/chat/completions`, {
                method: `POST`,
                models: [`flash`, `lite`],
                body: (model) => JSON.stringify({ model }),
            });

            await vi.advanceTimersByTimeAsync(20_000);

            expect((await pending)?.model).toBe(`lite`);
            // ONE timeout, not one per key: silence says the same thing on every credential in the pool.
            expect(attempts).toEqual([`flash`, `lite`]);
        } finally {
            vi.useRealTimers();
        }
    });

    it("skips the silent rung outright on the messages that follow", async () => {
        vi.useFakeTimers();
        try {
            const attempts: string[] = [];
            const fetchFn = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
                const model = (JSON.parse(String(init?.body)) as { model: string }).model;
                attempts.push(model);
                return model === `flash` ? new Promise<Response>(() => {}) : Promise.resolve(new Response(`{"choices":[1]}`, { status: 200 }));
            });
            const pool = createTrialPool(baseConfig, fetchFn as unknown as typeof fetch);
            const send = () =>
                pool.call(`/chat/completions`, { method: `POST`, models: [`flash`, `lite`], body: (model) => JSON.stringify({ model }) });

            const first = send();
            await vi.advanceTimersByTimeAsync(20_000);
            await first;
            attempts.length = 0;
            const second = await send();

            // The cooldown is what keeps the timeout to the first message rather than every message.
            expect(second?.model).toBe(`lite`);
            expect(attempts).toEqual([`lite`]);
        } finally {
            vi.useRealTimers();
        }
    });

    it("tries a cooling rung again rather than refusing when no rung is left", async () => {
        vi.useFakeTimers();
        try {
            let silent = true;
            const attempts: string[] = [];
            const fetchFn = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
                attempts.push((JSON.parse(String(init?.body)) as { model: string }).model);
                return silent ? new Promise<Response>(() => {}) : Promise.resolve(new Response(`{"choices":[1]}`, { status: 200 }));
            });
            const pool = createTrialPool(baseConfig, fetchFn as unknown as typeof fetch);
            const send = () =>
                pool.call(`/chat/completions`, { method: `POST`, models: [`flash`, `lite`], body: (model) => JSON.stringify({ model }) });

            const first = send();
            await vi.advanceTimersByTimeAsync(60_000);
            await first;
            silent = false;
            attempts.length = 0;

            // Both rungs are cooling, so the cooldown has no preference left to express and is ignored.
            expect((await send())?.model).toBe(`flash`);
            expect(attempts).toEqual([`flash`]);
        } finally {
            vi.useRealTimers();
        }
    });

    it("honours Retry-After when quarantining a rate-limited key", async () => {
        let at = Date.parse(`2026-08-16T00:00:00.000Z`);
        const auths: (string | undefined)[] = [];
        const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
            const auth = (init?.headers as Record<string, string> | undefined)?.[`authorization`];
            auths.push(auth);
            return new Response(`{}`, auth === `Bearer k1` ? { status: 429, headers: { "retry-after": `120` } } : { status: 200 });
        });
        const pool = createTrialPool(baseConfig, fetchFn as unknown as typeof fetch, () => at);

        await pool.call(`/chat/completions`, { method: `POST` });
        at += 119_000;
        await pool.call(`/chat/completions`, { method: `POST` });
        await pool.call(`/chat/completions`, { method: `POST` });
        expect(auths.filter((auth) => auth === `Bearer k1`)).toHaveLength(1);

        at += 1_000;
        await pool.call(`/chat/completions`, { method: `POST` });
        await pool.call(`/chat/completions`, { method: `POST` });
        expect(auths.filter((auth) => auth === `Bearer k1`)).toHaveLength(2);
    });
});

it(`the Prisma import stays referenced, so createApp's error mapping narrows on the same class app.test.ts uses`, () => {
    expect(Prisma).toBeDefined();
});
