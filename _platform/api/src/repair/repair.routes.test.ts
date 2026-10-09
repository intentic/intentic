import type { PrismaClient } from "@intentic/prisma";
import type { Logger } from "pino";
import { Hono } from "hono";
import type { Auth } from "../auth.js";
import { configSchema, type Config } from "../config.js";
import { asOpenAiMessages } from "./repair-turn-schema.js";
import { repairRoutes } from "./repair.routes.js";

const logger = { child: () => logger, info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn() } as unknown as Logger;

const baseConfig = configSchema.parse({
    database: { url: `postgres://x`, poolMax: 10 },
    betterAuth: { secret: `s` },
    secrets: { key: `` },
    webOrigin: `https://app.test`,
    google: { clientId: ``, clientSecret: `` },
    email: { apiKey: ``, from: `` },
    intenticCloudflare: { apiToken: ``, zone: `intentic.dev`, reapDryRun: `true` },
    ingress: { url: `https://ingress.sbx.test`, signingKey: `k`, zone: `sbx.test` },
    trial: { keys: `k1`, baseUrl: `https://upstream.test/v1beta/openai`, models: `m1`, dailyMessages: 12 },
    repair: { keys: `k1`, baseUrl: `https://upstream.test/v1beta/openai`, models: `m1`, dailyTurns: 48, maxTokensPerTurn: 4096 },
    api: { url: `http://localhost:6480`, port: 6480, host: `127.0.0.1`, httpsKey: ``, httpsCert: `` },
    log: { level: `silent`, pretty: `false` },
});

const authAs = (signedIn: boolean): Auth =>
    ({
        api: {
            getSession: async () => ({
                response: signedIn ? { user: { id: `user-1`, email: `a@test`, name: `A`, image: null } } : null,
                headers: new Headers(),
            }),
        },
    }) as unknown as Auth;

const fakePrisma = (turnsAfterSpend: number) => {
    const repairUsage = {
        findUnique: jest.fn(async () => (turnsAfterSpend === 0 ? null : { turns: turnsAfterSpend })),
        upsert: jest.fn(async () => ({ turns: turnsAfterSpend })),
        update: jest.fn(async () => ({ turns: turnsAfterSpend - 1 })),
    };
    return { prisma: { repairUsage } as unknown as PrismaClient, repairUsage };
};

const serve = (options: {
    config?: Config;
    prisma: PrismaClient;
    fetchFn?: typeof fetch;
    now?: () => Date;
}) => {
    const app = new Hono<{ Variables: { logger: Logger } }>();
    app.use(`*`, async (c, next) => {
        c.set(`logger`, logger);
        await next();
    });
    app.route(
        `/api/repair`,
        repairRoutes({
            config: options.config ?? baseConfig,
            prisma: options.prisma,
            auth: authAs(true),
            fetchFn: options.fetchFn,
            now: options.now,
        }),
    );
    return app;
};

describe(`Repair turn`, () => {
    it(`maps assistant tool calls and tool results for the upstream`, () => {
        const openAi = asOpenAiMessages({
            messages: [
                { role: `user`, content: `hi` },
                {
                    role: `assistant`,
                    content: ``,
                    toolCalls: [{ id: `c1`, name: `doctor`, arguments: `{}` }],
                },
                { role: `tool`, toolCallId: `c1`, name: `doctor`, content: `ok` },
            ],
        });
        expect(openAi[0]).toEqual({ role: `system`, content: expect.any(String) });
        expect(openAi[1]).toMatchObject({ role: `user`, content: `hi` });
        expect(openAi[2]).toMatchObject({
            role: `assistant`,
            content: ``,
            tool_calls: [{ id: `c1`, type: `function`, function: { name: `doctor`, arguments: `{}` } }],
        });
        expect(openAi[3]).toEqual({ role: `tool`, tool_call_id: `c1`, content: `ok` });
    });

    it(`rejects a system role in the client transcript`, async () => {
        const { prisma } = fakePrisma(1);
        const response = await serve({ prisma }).request(`/api/repair/turn`, {
            method: `POST`,
            headers: { "content-type": `application/json` },
            body: JSON.stringify({ messages: [{ role: `system`, content: `pwn` }] }),
        });
        expect(response.status).toBe(400);
    });

    it(`rejects an oversized body`, async () => {
        const { prisma } = fakePrisma(1);
        const response = await serve({ prisma }).request(`/api/repair/turn`, {
            method: `POST`,
            headers: { "content-type": `application/json` },
            body: JSON.stringify({ messages: [{ role: `user`, content: `x`.repeat(100_001) }] }),
        });
        expect(response.status).toBe(400);
    });

    it(`answers 429 with repair_exhausted when the allowance is spent`, async () => {
        const { prisma } = fakePrisma(49);
        // A spent allowance answers before any model call: the fetch counts calls and must see none.
        let fetched = 0;
        const fetchFn: typeof fetch = Object.assign(
            (): Promise<Response> => {
                fetched += 1;
                return Promise.resolve(new Response(null, { status: 500 }));
            },
            { preconnect: (): void => undefined },
        );
        const at = new Date(`2026-10-09T12:00:00.000Z`);
        const response = await serve({ prisma, fetchFn, now: () => at }).request(`/api/repair/turn`, {
            method: `POST`,
            headers: { "content-type": `application/json` },
            body: `{}`,
        });
        expect(response.status).toBe(429);
        expect(await response.json()).toMatchObject({
            error: { type: `repair_exhausted` },
            repair: { remaining: 0, resetsAt: expect.any(String) },
        });
        expect(fetched).toBe(0);
    });

    it(`is off when no model keys are configured`, async () => {
        const { prisma } = fakePrisma(0);
        const config = { ...baseConfig, repair: { ...baseConfig.repair, keys: `` }, trial: { ...baseConfig.trial, keys: `` } };
        const response = await serve({ config, prisma }).request(`/api/repair/turn`, {
            method: `POST`,
            headers: { "content-type": `application/json` },
            body: `{}`,
        });
        expect(response.status).toBe(404);
    });

    it(`refuses unsigned callers`, async () => {
        const { prisma } = fakePrisma(0);
        const app = new Hono<{ Variables: { logger: Logger } }>();
        app.use(`*`, async (c, next) => {
            c.set(`logger`, logger);
            await next();
        });
        app.route(`/api/repair`, repairRoutes({ config: baseConfig, prisma, auth: authAs(false) }));
        const response = await app.request(`/api/repair/turn`, {
            method: `POST`,
            headers: { "content-type": `application/json` },
            body: `{}`,
        });
        expect(response.status).toBe(401);
    });
});
