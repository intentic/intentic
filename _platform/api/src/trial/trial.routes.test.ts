import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@intentic-app/prisma";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import { createApp } from "../app.js";
import type { Config } from "../config.js";

/* THE TRIAL IS THE ONE ROUTE FAMILY THAT SPENDS INTENTIC'S OWN MONEY, so the things worth pinning here are the
 * ones that cost something when they break: the allowance actually stopping a caller, a refused key moving to
 * the next one instead of surfacing, and a turn nobody served not being billed. */

const logger = { child: () => logger, info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;

const baseConfig = {
    database: { url: `postgres://x`, poolMax: 10 },
    betterAuth: { secret: `s` },
    secrets: { key: `` },
    webOrigin: `https://app.test`,
    google: { clientId: ``, clientSecret: `` },
    email: { apiKey: ``, from: `` },
    intenticCloudflare: { apiToken: ``, zone: `intentic.dev`, reapDryRun: true },
    zrok: { apiEndpoint: `https://zrok2.sbx.test`, agentEndpoint: ``, adminToken: `hub-admin`, zone: `sbx.test` },
    trial: { keys: `k1,k2`, baseUrl: `https://upstream.test/v1beta/openai`, models: ``, dailyMessages: 2 },
    api: { url: `http://localhost:6480`, port: 6480, host: `127.0.0.1`, httpsKey: ``, httpsCert: `` },
    log: { level: `silent`, pretty: false },
} as Config;

const configWith = (trial: Partial<Config["trial"]>): Config => ({ ...baseConfig, trial: { ...baseConfig.trial, ...trial } });

// The digest the routes look a connect token up by — the same one /sandbox/announce uses.
const digestOf = (token: string) => createHash(`sha256`).update(token).digest(`hex`);

interface Counters {
    readonly used?: number;
}

const fakePrisma = ({ used }: Counters = {}) => {
    let messages = used ?? 0;
    const trialUsage = {
        findUnique: vi.fn(async () => (messages === 0 ? null : { messages })),
        upsert: vi.fn(async () => {
            messages += 1;
            return { messages };
        }),
        update: vi.fn(async () => {
            messages -= 1;
            return { messages };
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
        expect(await response.json()).toMatchObject({ allowance: 2, used: 0, remaining: 2 });
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
        // Nothing was sent upstream — a refused turn must not spend the pool as well as the allowance.
        expect(fetchFn).not.toHaveBeenCalled();
        vi.unstubAllGlobals();
    });

    it("moves to the next key when one is rate-limited, rather than surfacing the refusal", async () => {
        const { prisma } = fakePrisma();
        const fetchFn = vi
            .fn()
            .mockResolvedValueOnce(new Response(`{"error":"quota"}`, { status: 429 }))
            .mockResolvedValueOnce(new Response(`{"choices":[1]}`, { status: 200, headers: { "content-type": `application/json` } }));
        vi.stubGlobal(`fetch`, fetchFn);

        const response = await chat(baseConfig, prisma);

        expect(response.status).toBe(200);
        expect(await response.text()).toBe(`{"choices":[1]}`);
        expect(fetchFn).toHaveBeenCalledTimes(2);
        vi.unstubAllGlobals();
    });

    it("gives the message back when no key could serve it", async () => {
        const { prisma, spent } = fakePrisma();
        const fetchFn = vi.fn(async () => new Response(`{}`, { status: 503 }));
        vi.stubGlobal(`fetch`, fetchFn);

        const response = await chat(baseConfig, prisma);

        expect(response.status).toBe(502);
        // Both keys tried, and the user is not billed for a turn nobody served.
        expect(fetchFn).toHaveBeenCalledTimes(2);
        expect(spent()).toBe(0);
        vi.unstubAllGlobals();
    });

    it("refunds — and does not repeat Google's billing advice — when the whole pool is rate-limited", async () => {
        const { prisma, spent } = fakePrisma();
        const fetchFn = vi.fn(async () => new Response(`{"error":{"message":"check your plan and billing details"}}`, { status: 429 }));
        vi.stubGlobal(`fetch`, fetchFn);

        const response = await chat(baseConfig, prisma);

        // The ceiling is intentic's, not the reader's: they hold no plan with Google and never asked for one.
        expect(response.status).toBe(502);
        expect(await response.text()).not.toContain(`billing`);
        // And an allowance that keeps counting down through turns nobody served is not an allowance.
        expect(fetchFn).toHaveBeenCalledTimes(2);
        expect(spent()).toBe(0);
        vi.unstubAllGlobals();
    });

    it("serves only the allowlisted models when one is configured", async () => {
        const { prisma } = fakePrisma();
        const fetchFn = vi.fn(
            async () =>
                new Response(JSON.stringify({ data: [{ id: `models/keep-me` }, { id: `models/drop-me` }] }), {
                    status: 200,
                    headers: { "content-type": `application/json` },
                }),
        );
        vi.stubGlobal(`fetch`, fetchFn);

        const response = await call(configWith({ models: `keep-me` }), prisma, `/trial/v1/models`);

        // The `models/` prefix Google puts on this surface is stripped — the harness addresses the bare id.
        expect(await response.json()).toEqual({ object: `list`, data: [{ id: `keep-me`, object: `model`, owned_by: `intentic-trial` }] });
        vi.unstubAllGlobals();
    });

    /* THE WAY THE TRIAL ACTUALLY DIED, and the reason the configured list is a floor rather than a filter:
     * Google's OpenAI-compatible /models answers a fresh key with an empty list while chat on that same key
     * answers normally. Discovery alone therefore offered nothing to select, on a trial that worked — so every
     * picker said "no models" and the feature was unreachable without a single error anywhere. */
    it("offers the configured models when the upstream publishes none", async () => {
        const { prisma } = fakePrisma();
        const fetchFn = vi.fn(
            async () => new Response(JSON.stringify({ object: `list`, data: [] }), { status: 200, headers: { "content-type": `application/json` } }),
        );
        vi.stubGlobal(`fetch`, fetchFn);

        const response = await call(configWith({ models: `gemini-flash-latest,gemini-3.7-flash` }), prisma, `/trial/v1/models`);

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
            object: `list`,
            data: [
                { id: `gemini-flash-latest`, object: `model`, owned_by: `intentic-trial` },
                { id: `gemini-3.7-flash`, object: `model`, owned_by: `intentic-trial` },
            ],
        });
        vi.unstubAllGlobals();
    });

    it("keeps offering them when the upstream catalog cannot be read at all", async () => {
        const { prisma } = fakePrisma();
        const fetchFn = vi.fn(async () => new Response(`{}`, { status: 503 }));
        vi.stubGlobal(`fetch`, fetchFn);

        const response = await call(configWith({ models: `gemini-flash-latest` }), prisma, `/trial/v1/models`);

        // NOT a 502. Which models this trial serves is a question the operator has already answered, and a
        // momentarily unreachable listing surface must not empty a picker the user is choosing from.
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({ object: `list`, data: [{ id: `gemini-flash-latest`, object: `model`, owned_by: `intentic-trial` }] });
        vi.unstubAllGlobals();
    });

    it("still names models when neither the upstream nor the operator does", async () => {
        const { prisma } = fakePrisma();
        const fetchFn = vi.fn(
            async () => new Response(JSON.stringify({ data: [] }), { status: 200, headers: { "content-type": `application/json` } }),
        );
        vi.stubGlobal(`fetch`, fetchFn);

        // Blank is what every deployment's env actually holds, so this is the case the trial has to survive:
        // the built-in floor lives in code precisely so that leaving a line blank cannot empty the picker.
        const response = await call(configWith({ models: `` }), prisma, `/trial/v1/models`);

        expect(response.status).toBe(200);
        const body = (await response.json()) as { data: { id: string }[] };
        expect(body.data.length).toBeGreaterThan(0);
        // Aliases, not pinned versions — the pin is what went stale and took the feature with it.
        expect(body.data.every((model) => model.id.endsWith(`-latest`))).toBe(true);
        vi.unstubAllGlobals();
    });
});

// Referenced so the Prisma import matches app.test.ts's (createApp's error mapping narrows on it).
expect(Prisma).toBeDefined();
