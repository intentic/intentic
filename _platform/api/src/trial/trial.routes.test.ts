import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@intentic/prisma";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import { configSchema, type Config } from "../config.js";
import { createTrialPool } from "./trial-pool.js";

// The trial spends intentic's own money, so what's pinned here is what costs something when it breaks: the allowance
// actually stopping a caller, a refused key failing over silently, and an unserved turn not being billed.

const logger = { child: () => logger, info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;

const baseConfig = configSchema.parse({
    database: { url: `postgres://x`, poolMax: 10 },
    betterAuth: { secret: `s` },
    secrets: { key: `` },
    webOrigin: `https://app.test`,
    google: { clientId: ``, clientSecret: `` },
    email: { apiKey: ``, from: `` },
    intenticCloudflare: { apiToken: ``, zone: `intentic.dev`, reapDryRun: `true` },
    ingress: { url: `https://ingress.sbx.test`, signingKey: `k`, zone: `sbx.test` },
    trial: { keys: `k1,k2`, baseUrl: `https://upstream.test/v1beta/openai`, models: ``, dailyMessages: 2 },
    api: { url: `http://localhost:6480`, port: 6480, host: `127.0.0.1`, httpsKey: ``, httpsCert: `` },
    log: { level: `silent`, pretty: `false` },
});

const configWith = (trial: Partial<Config["trial"]>): Config => ({ ...baseConfig, trial: { ...baseConfig.trial, ...trial } });

// Digest the routes look a connect token up by; the same one /sandbox/announce uses.
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
        // One `update` mock serves both the refund (decrement) and the served-model write (sets a name); branches on
        // the payload so a test can't pass by triggering the wrong one.
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

        // 404, not 401: a platform running no trial has nothing here to guess tokens against.
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
        // Fixture starts at the allowance ceiling; this call is the one that should be refused.
        const { prisma } = fakePrisma({ used: 2 });
        const fetchFn = vi.fn(async () => new Response(`{}`, { status: 200 }));
        vi.stubGlobal(`fetch`, fetchFn);

        const response = await chat(baseConfig, prisma);

        expect(response.status).toBe(429);
        const body = (await response.json()) as { error: { type: string; message: string }; trial: { allowance: number; resetsAt: string } };
        expect(body.error.type).toBe(`trial_exhausted`);
        expect(body.error.message).toContain(`${body.trial.allowance} messages`);
        expect(body.error.message).toContain(body.trial.resetsAt);
        // A refused turn must not also spend the pool.
        expect(fetchFn).not.toHaveBeenCalled();
        vi.unstubAllGlobals();
    });

    // Filters to just the chat POSTs: the ladder's own capability GET rides the same pool, and call-order would
    // describe that read instead.
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
        // Same model, next key: a refused key is failover's job, not the ladder's.
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
        // Every rung tried on every key before refusing; not billed once per rung, or at all, for an unserved turn.
        expect(chatPosts(fetchFn)).toHaveLength(4);
        expect(spent()).toBe(0);
        vi.unstubAllGlobals();
    });

    it("gives the message back when upstream rejects the model or request", async () => {
        const { prisma, spent } = fakePrisma();
        const fetchFn = vi.fn(async () => new Response(`{"error":{"message":"model not supported"}}`, { status: 404 }));
        vi.stubGlobal(`fetch`, fetchFn);

        const response = await chat(baseConfig, prisma);

        // Preserves the actionable upstream response, but never charges for a completion that never happened.
        expect(response.status).toBe(404);
        expect(JSON.parse(await response.text())).toEqual({ error: { message: `model not supported` } });
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
        // An allowance that counts down through turns nobody served isn't an allowance.
        expect(chatPosts(fetchFn)).toHaveLength(4);
        expect(spent()).toBe(0);
        vi.unstubAllGlobals();
    });

    // Stubs the two listing surfaces the ladder reads (the compat shim's ids-only list, and Google's own capability
    // list); chat POSTs fall through to a plain success.
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

    // A capability filter alone would still rank an unusable model first; publishing one synthetic id makes that
    // impossible.
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

    // Constancy matters across two independent readers: the sandbox's translator writes its routing table from this
    // catalog at boot, the picker re-reads it every minute, and a catalog that moved between them would offer a row the
    // translator refuses.
    it("publishes the same one model when the upstream cannot be read at all", async () => {
        const { prisma } = fakePrisma();
        vi.stubGlobal(
            `fetch`,
            vi.fn(async () => new Response(`{}`, { status: 503 })),
        );

        const response = await call(configWith({ models: `` }), prisma, `/trial/v1/models`);

        // Not a 502, not an empty list: what this trial offers isn't a question the upstream gets to answer.
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
            object: `list`,
            data: [{ id: `auto`, object: `model`, owned_by: `intentic-trial`, display_name: `Free trial` }],
        });
        vi.unstubAllGlobals();
    });

    it("sends a real model upstream, never the id the caller asked for", async () => {
        const { prisma } = fakePrisma();
        const fetchFn = upstream([`gemini-flash-latest`, `gemini-flash-lite-latest`]);
        vi.stubGlobal(`fetch`, fetchFn);

        const response = await call(baseConfig, prisma, `/trial/v1/chat/completions`, { method: `POST`, body: `{"model":"auto","stream":true}` });

        expect(response.status).toBe(200);
        const sent = fetchFn.mock.calls.find(([, init]) => init?.method === `POST`)?.[1];
        expect(JSON.parse(String(sent?.body))).toEqual({ model: `gemini-flash-latest`, stream: true });
        // The answer says which model ran; a routed trial the user can't see into is a black box.
        expect(response.headers.get(`x-intentic-trial-model`)).toBe(`gemini-flash-latest`);
        vi.unstubAllGlobals();
    });

    // Quotas are per model, so Flash's window closing says nothing about Lite.
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
        // Both keys tried on the exhausted model before the next rung, not a key sidelined for one model's quota.
        expect(asked).toEqual([`gemini-flash-latest`, `gemini-flash-latest`, `gemini-flash-lite-latest`]);
        expect(response.headers.get(`x-intentic-trial-model`)).toBe(`gemini-flash-lite-latest`);
        // Billed once, for the message the user actually got, not once per rung tried.
        expect(spent()).toBe(1);
        vi.unstubAllGlobals();
    });

    // Discovery may only remove rungs we named, never add ones we didn't: a retired model stops being used without a
    // release, but an unvetted family can't reach a user by appearing in a catalog.
    it("stops routing to a rung the upstream has retired", async () => {
        const { prisma } = fakePrisma();
        // Flash is missing from the listing; only Lite remains of the ladder.
        const fetchFn = upstream([`gemini-flash-lite-latest`, `deep-research-max-preview-01`]);
        vi.stubGlobal(`fetch`, fetchFn);

        // One app across both messages: the ladder's cache lives on the route instance, so a fresh app per request
        // would never exercise the veto.
        const app = createApp(baseConfig, prisma, logger).app;
        const headers = { authorization: `Bearer tok`, "content-type": `application/json` };
        const send = () => app.request(`/trial/v1/chat/completions`, { method: `POST`, headers, body: `{"model":"auto"}` });

        // First message answers from the unfiltered ladder and kicks off the capability read in the background; the
        // veto only lands on the next one.
        await send();
        await vi.waitFor(() => expect(fetchFn.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method !== `POST`)).toBe(true));
        const before = chatPosts(fetchFn).length;
        const response = await send();

        expect(response.status).toBe(200);
        // The surviving rung, never the chat-capable model we never vetted, however loudly the upstream declares it.
        expect(
            chatPosts(fetchFn)
                .slice(before)
                .map(([, init]) => JSON.parse(String((init as RequestInit).body)).model),
        ).toEqual([`gemini-flash-lite-latest`]);
        vi.unstubAllGlobals();
    });

    // Replaces the curated ladder wholesale; can't be filtered against Google's vocabulary since it's meant for ids
    // we've never heard of.
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

    it("reads a pasted `#` note as the blank setting it annotates, not as a model", async () => {
        const { prisma } = fakePrisma();
        const fetchFn = upstream([`gemini-flash-latest`]);
        vi.stubGlobal(`fetch`, fetchFn);

        const models = `# optional allowlist; empty = whatever upstream serves`;
        const response = await call(configWith({ models }), prisma, `/trial/v1/chat/completions`, { method: `POST`, body: `{"model":"auto"}` });

        expect(response.status).toBe(200);
        const sent = fetchFn.mock.calls.find(([, init]) => init?.method === `POST`)?.[1];
        // Falls back to the curated ladder; the comment text itself is not something any upstream would answer for.
        expect(JSON.parse(String(sent?.body))).toEqual({ model: `gemini-flash-latest` });
        vi.unstubAllGlobals();
    });

    // Can't ride the chat response: the sandbox's translator sits between us and drops headers, so the status poll it
    // already makes is the channel.
    it("remembers which model served, and reports it on the status read", async () => {
        const { prisma } = fakePrisma();
        vi.stubGlobal(`fetch`, upstream([`gemini-flash-latest`]));

        await chat(baseConfig, prisma);
        const status = await call(baseConfig, prisma, `/trial/status`);

        expect(await status.json()).toMatchObject({ servedModel: `gemini-flash-latest` });
        vi.unstubAllGlobals();
    });

    // One key only, so the result can't depend on where the pool's rotation happened to start.
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

        // Third rotation would start on k1 again; quarantine skips straight to the good key.
        expect(auths).toEqual([`Bearer k1`, `Bearer k2`, `Bearer k2`, `Bearer k2`]);
        expect(pool.status().health).toBe(`degraded`);
    });

    it("stops reporting degraded once the windows it was degraded for have closed", async () => {
        let clock = 1_000;
        const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
            const auth = (init?.headers as Record<string, string> | undefined)?.[`authorization`];
            // k1 is refused only while the clock is early; it works again once time has moved past the quarantine.
            return new Response(`{}`, { status: auth === `Bearer k1` && clock < 60_000 ? 401 : 200 });
        });
        const pool = createTrialPool(baseConfig, fetchFn as unknown as typeof fetch, () => clock);

        await pool.call(`/chat/completions`, { method: `POST`, observeHealth: true });
        expect(pool.status().health).toBe(`degraded`);

        // Past the quarantine window, with nobody sending anything: the reading has outlived its cause.
        clock += 5 * 60_000 + 1;
        expect(pool.status()).toEqual({ health: `healthy` });

        // Confirmed by a live message too, not only the passive status read.
        await pool.call(`/chat/completions`, { method: `POST`, observeHealth: true });
        expect(pool.status()).toEqual({ health: `healthy` });
    });

    it("does not read a refused capability listing as the chat path being unwell", async () => {
        const fetchFn = vi.fn(async (_url: string | URL | Request, init?: RequestInit) =>
            init?.method === `GET` ? new Response(`{}`, { status: 429 }) : new Response(`{"choices":[1]}`, { status: 200 }),
        );
        const pool = createTrialPool(baseConfig, fetchFn as unknown as typeof fetch);

        // Listing refused on every key; it must not register as chat-path health.
        await pool.call(``, { method: `GET`, url: `https://upstream.test/v1beta/models`, auth: `goog` });
        await pool.call(`/chat/completions`, { method: `POST`, models: [`flash`], body: () => `{}`, observeHealth: true });

        expect(pool.status().health).toBe(`healthy`);
    });

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
        // Both keys refused on flash; the same keys are tried again for lite, and the first one answers.
        expect(attempts).toEqual([
            { key: `Bearer k1`, model: `flash` },
            { key: `Bearer k2`, model: `flash` },
            { key: `Bearer k1`, model: `lite` },
        ]);
        expect(attempt?.model).toBe(`lite`);
    });

    it("abandons a silent rung for the fallback instead of timing out on every key", async () => {
        vi.useFakeTimers();
        try {
            const attempts: string[] = [];
            const fetchFn = vi.fn((_url: string | URL | Request, init?: RequestInit) => {
                const model = (JSON.parse(String(init?.body)) as { model: string }).model;
                attempts.push(model);
                // Silence, not a refusal — the case a per-key walk alone can't tell apart from a slow answer.
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
            // One timeout only, not one per key: silence is the same fact on every credential.
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

            // The cooldown is what limits the timeout cost to the first message, not every message after it.
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

            // Both rungs are cooling, so the cooldown has nothing left to prefer and is ignored.
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
    // app.test.ts actually spends the member `Prisma.DbNull`, not the namespace; an empty-module resolution would still
    // satisfy "defined" while breaking the error mapping.
    expect(Prisma.DbNull).toBeInstanceOf(Object);
});
