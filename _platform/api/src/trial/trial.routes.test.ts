import { GOOGLE_REQUIRED_REASON } from "@intentic/api-contract";
import { createHash } from "node:crypto";
import { Prisma, type PrismaClient } from "@intentic/prisma";
import type { Logger } from "pino";
import { waitFor, stubGlobal, unstubAllGlobals, advanceTimersByTimeAsync } from "@intentic/testing/bun";
import { createApp } from "../app.js";
import { configSchema, type Config } from "../config.js";
import { createTrialPool } from "./trial-pool.js";

// The trial spends intentic's own money, so what's pinned here is what costs something when it breaks: the allowance
// actually stopping a caller, a refused key failing over silently, and an unserved turn not being billed.

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
    trial: { keys: `k1,k2`, baseUrl: `https://upstream.test/v1beta/openai`, models: ``, dailyMessages: 2 },
    api: { url: `http://localhost:6480`, port: 6480, host: `127.0.0.1`, httpsKey: ``, httpsCert: `` },
    log: { level: `silent`, pretty: `false` },
});

const configWith = (trial: Partial<Config["trial"]>): Config => ({ ...baseConfig, trial: { ...baseConfig.trial, ...trial } });

// Digest the routes look a connect token up by; the same one /sandbox/announce uses.
const digestOf = (token: string) => createHash(`sha256`).update(token).digest(`hex`);

interface Counters {
    readonly used?: number;
    // Google accounts linked to the owner's: the trial is a free lane, open only with one (free-lane.ts).
    readonly googleAccounts?: number;
    // Today's turn grace as the row holds it: turns opened with allowance left and not closed, when the latest opened,
    // and the grace steps spent.
    readonly graceOpen?: number;
    readonly graceOpenedAt?: Date;
    readonly graceSteps?: number;
}

// The bounds trial-usage.ts filters its conditional updates by, read the way Postgres would (a null date is never in
// range).
interface Bound {
    readonly lt?: number;
    readonly gt?: number;
    readonly gte?: Date;
}
type Change = number | { readonly increment?: number; readonly decrement?: number };
type Counted = `messages` | `graceOpen` | `graceSteps`;
interface RowWhere extends Partial<Record<Counted, Bound>> {
    readonly graceOpenedAt?: Bound;
}
interface RowData extends Partial<Record<Counted, Change>> {
    readonly graceOpenedAt?: Date;
}

const inBound = (value: number, bound: Bound): boolean =>
    (bound.lt === undefined || value < bound.lt) && (bound.gt === undefined || value > bound.gt) && (bound.gte === undefined || value >= bound.gte.getTime());
const changed = (value: number, change: Change): number =>
    change instanceof Object ? value + (change.increment ?? 0) - (change.decrement ?? 0) : change;

const fakePrisma = ({ used, googleAccounts = 1, graceOpen = 0, graceOpenedAt, graceSteps = 0 }: Counters = {}) => {
    const row = { messages: used ?? 0, lastModel: null as string | null, graceOpen, graceOpenedAt: graceOpenedAt ?? null, graceSteps };
    const counted: readonly Counted[] = [`messages`, `graceOpen`, `graceSteps`];
    const matches = (where: RowWhere): boolean =>
        counted.every((field) => where[field] === undefined || inBound(row[field], where[field])) &&
        (where.graceOpenedAt === undefined || inBound(row.graceOpenedAt?.getTime() ?? Number.NEGATIVE_INFINITY, where.graceOpenedAt));
    const trialUsage = {
        findUnique: jest.fn(async () => (row.messages === 0 && row.lastModel === null && row.graceSteps === 0 ? null : { ...row })),
        // A spend increments; an opening turn only makes sure today's row exists.
        upsert: jest.fn(async ({ update }: { update: RowData }) => {
            if (update.messages !== undefined) {
                row.messages += 1;
            }
            return { ...row };
        }),
        // One `update` mock serves both the refund (decrement) and the served-model write (sets a name); branches on
        // the payload so a test can't pass by triggering the wrong one.
        update: jest.fn(async ({ data }: { data: RowData & { lastModel?: string } }) => {
            if (typeof data.lastModel === `string`) {
                row.lastModel = data.lastModel;
                return { ...row };
            }
            row.messages -= 1;
            if (data.graceSteps !== undefined) {
                row.graceSteps = changed(row.graceSteps, data.graceSteps);
            }
            return { ...row };
        }),
        updateMany: jest.fn(async ({ where, data }: { where: RowWhere; data: RowData }) => {
            if (!matches(where)) {
                return { count: 0 };
            }
            for (const field of counted) {
                const change = data[field];
                if (change !== undefined) {
                    row[field] = changed(row[field], change);
                }
            }
            row.graceOpenedAt = data.graceOpenedAt ?? row.graceOpenedAt;
            return { count: 1 };
        }),
    };
    const prisma = {
        sandbox: {
            findUnique: jest.fn(async ({ where }: { where: { tokenDigest: string } }) =>
                where.tokenDigest === digestOf(`tok`) ? { ownerId: `user-1` } : null,
            ),
        },
        trialUsage,
        account: { count: jest.fn(async () => googleAccounts) },
    };
    return { prisma: prisma as unknown as PrismaClient, trialUsage, spent: () => row.messages, graceSpent: () => row.graceSteps };
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
        const fetchFn = jest.fn(async () => new Response(`{"choices":[]}`, { status: 200, headers: { "content-type": `application/json` } }));
        stubGlobal(`fetch`, fetchFn);

        const response = await chat(baseConfig, prisma);

        expect(response.status).toBe(200);
        expect(await response.text()).toBe(`{"choices":[]}`);
        expect(spent()).toBe(1);
        unstubAllGlobals();
    });

    // A free lane: an owner who signs in only by email reaches it once Google is linked (free-lane.ts), and is told so.
    it("is closed to a sandbox whose owner has no Google sign-in linked, spending nothing and saying why", async () => {
        const { prisma, spent } = fakePrisma({ googleAccounts: 0 });
        const status = await call(baseConfig, prisma, `/trial/status`);
        expect(status.status).toBe(403);
        const refused = await chat(baseConfig, prisma);
        expect(refused.status).toBe(403);
        expect(await refused.json()).toEqual({
            error: `the free trial needs a Google sign-in linked to this sandbox owner's account: link Google in Settings, or connect a model of your own`,
            reason: GOOGLE_REQUIRED_REASON,
        });
        expect(spent()).toBe(0);
    });

    it("refuses once the day's allowance is gone, and names the way forward", async () => {
        // Fixture starts at the allowance ceiling; this call is the one that should be refused.
        const { prisma } = fakePrisma({ used: 2 });
        const fetchFn = jest.fn(async () => new Response(`{}`, { status: 200 }));
        stubGlobal(`fetch`, fetchFn);

        const response = await chat(baseConfig, prisma);

        expect(response.status).toBe(429);
        const body = (await response.json()) as { error: { type: string; message: string }; trial: { allowance: number; resetsAt: string } };
        expect(body.error.type).toBe(`trial_exhausted`);
        // Counts what the trial meters (one agent step per model call), and points at any model rather than one vendor's
        // sign-in: Google's route signs in as a third-party app its terms keep out of other clients (F03).
        expect(body.error.message).toBe(
            `Free trial used up for today (${body.trial.allowance} agent steps, one per model call). Resets at ${body.trial.resetsAt}. Connect a model to keep going.`,
        );
        // A refused turn must not also spend the pool.
        expect(fetchFn).not.toHaveBeenCalled();
        unstubAllGlobals();
    });

    // Filters to just the chat POSTs: the ladder's own capability GET rides the same pool, and call-order would
    // describe that read instead.
    const chatPosts = (fetchFn: ReturnType<typeof jest.fn>) =>
        fetchFn.mock.calls.filter(([, init]) => (init as RequestInit | undefined)?.method === `POST`);

    it("moves to the next key when one is rate-limited, rather than surfacing the refusal", async () => {
        const { prisma } = fakePrisma();
        let posts = 0;
        const fetchFn = jest.fn(async (_url: string, init?: RequestInit) => {
            if (init?.method !== `POST`) {
                return new Response(`{}`, { status: 503 });
            }
            posts += 1;
            return posts === 1
                ? new Response(`{"error":"quota"}`, { status: 429 })
                : new Response(`{"choices":[1]}`, { status: 200, headers: { "content-type": `application/json` } });
        });
        stubGlobal(`fetch`, fetchFn);

        const response = await chat(baseConfig, prisma);

        expect(response.status).toBe(200);
        expect(await response.text()).toBe(`{"choices":[1]}`);
        // Same model, next key: a refused key is failover's job, not the ladder's.
        expect(chatPosts(fetchFn)).toHaveLength(2);
        expect(chatPosts(fetchFn).every(([, init]) => JSON.parse(String((init as RequestInit).body)).model === `gemini-flash-latest`)).toBe(true);
        unstubAllGlobals();
    });

    it("gives the message back when no key could serve it on any model", async () => {
        const { prisma, spent } = fakePrisma();
        const fetchFn = jest.fn(async () => new Response(`{}`, { status: 503 }));
        stubGlobal(`fetch`, fetchFn);

        const response = await chat(baseConfig, prisma);

        expect(response.status).toBe(502);
        // Every rung tried on every key before refusing; not billed once per rung, or at all, for an unserved turn.
        expect(chatPosts(fetchFn)).toHaveLength(4);
        expect(spent()).toBe(0);
        unstubAllGlobals();
    });

    /* A REFUND THAT DID NOT LAND IS A CHARGE FOR NOTHING: said in the log, while the caller still gets its own answer. */
    it("logs a refund the database refused, and still answers the unserved turn with its 502", async () => {
        const { prisma, trialUsage, spent } = fakePrisma();
        trialUsage.update.mockRejectedValueOnce(new Error(`connection terminated`));
        (logger.error as ReturnType<typeof jest.fn>).mockClear();
        stubGlobal(
            `fetch`,
            jest.fn(async () => new Response(`{}`, { status: 503 })),
        );

        const response = await chat(baseConfig, prisma);

        expect(response.status).toBe(502);
        expect(spent()).toBe(1);
        expect(logger.error).toHaveBeenCalledWith(
            { err: expect.any(Error), userId: `user-1`, day: expect.stringMatching(/^\d{4}-\d{2}-\d{2}$/) },
            `trial: refunding an unserved message failed; it stays spent`,
        );
        unstubAllGlobals();
    });

    it("gives the message back when upstream rejects the model or request", async () => {
        const { prisma, spent } = fakePrisma();
        const fetchFn = jest.fn(async () => new Response(`{"error":{"message":"model not supported"}}`, { status: 404 }));
        stubGlobal(`fetch`, fetchFn);

        const response = await chat(baseConfig, prisma);

        // Preserves the actionable upstream response, but never charges for a completion that never happened.
        expect(response.status).toBe(404);
        expect(JSON.parse(await response.text())).toEqual({ error: { message: `model not supported` } });
        expect(spent()).toBe(0);
        unstubAllGlobals();
    });

    it("publishes service health from real chat traffic", async () => {
        const { prisma } = fakePrisma();
        stubGlobal(
            `fetch`,
            jest.fn(async () => new Response(`{}`, { status: 503 })),
        );
        const app = createApp(baseConfig, prisma, logger).app;
        const headers = { authorization: `Bearer tok`, "content-type": `application/json` };

        const failed = await app.request(`/trial/v1/chat/completions`, { method: `POST`, headers, body: `{"model":"m"}` });
        const status = await app.request(`/trial/status`, { headers });

        expect(failed.status).toBe(502);
        expect(await status.json()).toMatchObject({ health: `unavailable`, retryAt: expect.any(String) });
        unstubAllGlobals();
    });

    it("refunds, and does not repeat Google's billing advice, when the whole pool is rate-limited", async () => {
        const { prisma, spent } = fakePrisma();
        const fetchFn = jest.fn(async () => new Response(`{"error":{"message":"check your plan and billing details"}}`, { status: 429 }));
        stubGlobal(`fetch`, fetchFn);

        const response = await chat(baseConfig, prisma);

        // The ceiling is intentic's, not the reader's: they hold no plan with Google and never asked for one.
        expect(response.status).toBe(502);
        expect(await response.text()).not.toContain(`billing`);
        // An allowance that counts down through turns nobody served isn't an allowance.
        expect(chatPosts(fetchFn)).toHaveLength(4);
        expect(spent()).toBe(0);
        unstubAllGlobals();
    });

    // Stubs the two listing surfaces the ladder reads (the compat shim's ids-only list, and Google's own capability
    // list); chat POSTs fall through to a plain success.
    const upstream = (generateContent: readonly string[]) =>
        jest.fn(async (url: string, init?: RequestInit) => {
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
        stubGlobal(`fetch`, upstream([`antigravity-preview-05-2026`, `deep-research-pro-preview-12`, `gemma-4-26b-a4b-it`, `gemini-flash-latest`]));

        const response = await call(configWith({ models: `` }), prisma, `/trial/v1/models`);

        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
            object: `list`,
            data: [{ id: `auto`, object: `model`, owned_by: `intentic-trial`, display_name: `Free trial` }],
        });
        unstubAllGlobals();
    });

    // Constancy matters across two independent readers: the sandbox's translator writes its routing table from this
    // catalog at boot, the picker re-reads it every minute, and a catalog that moved between them would offer a row the
    // translator refuses.
    it("publishes the same one model when the upstream cannot be read at all", async () => {
        const { prisma } = fakePrisma();
        stubGlobal(
            `fetch`,
            jest.fn(async () => new Response(`{}`, { status: 503 })),
        );

        const response = await call(configWith({ models: `` }), prisma, `/trial/v1/models`);

        // Not a 502, not an empty list: what this trial offers isn't a question the upstream gets to answer.
        expect(response.status).toBe(200);
        expect(await response.json()).toEqual({
            object: `list`,
            data: [{ id: `auto`, object: `model`, owned_by: `intentic-trial`, display_name: `Free trial` }],
        });
        unstubAllGlobals();
    });

    it("sends a real model upstream, never the id the caller asked for", async () => {
        const { prisma } = fakePrisma();
        const fetchFn = upstream([`gemini-flash-latest`, `gemini-flash-lite-latest`]);
        stubGlobal(`fetch`, fetchFn);

        const response = await call(baseConfig, prisma, `/trial/v1/chat/completions`, { method: `POST`, body: `{"model":"auto","stream":true}` });

        expect(response.status).toBe(200);
        const sent = fetchFn.mock.calls.find(([, init]) => init?.method === `POST`)?.[1];
        expect(JSON.parse(String(sent?.body))).toEqual({ model: `gemini-flash-latest`, stream: true });
        // The answer says which model ran; a routed trial the user can't see into is a black box.
        expect(response.headers.get(`x-intentic-trial-model`)).toBe(`gemini-flash-latest`);
        unstubAllGlobals();
    });

    // The body the sandbox's translator sends for a screenshot the agent read: Google refuses an image part outside a
    // `user` message with a 400 the user can do nothing about, so the route moves it before spending anything.
    it("moves an image out of a tool result before forwarding the turn", async () => {
        const { prisma, spent } = fakePrisma();
        const fetchFn = upstream([`gemini-flash-latest`]);
        stubGlobal(`fetch`, fetchFn);
        const image = { type: `image_url`, image_url: { url: `data:image/png;base64,AAAA` } };
        const body = JSON.stringify({
            model: `auto`,
            messages: [
                { role: `user`, content: [{ type: `text`, text: `read /tmp/shot.png` }] },
                { role: `assistant`, content: ``, tool_calls: [{ id: `call_1`, type: `function`, function: { name: `Read`, arguments: `{}` } }] },
                { role: `tool`, tool_call_id: `call_1`, content: [image] },
            ],
        });

        const response = await call(baseConfig, prisma, `/trial/v1/chat/completions`, { method: `POST`, body });

        expect(response.status).toBe(200);
        expect(spent()).toBe(1);
        const sent = JSON.parse(String(fetchFn.mock.calls.find(([, init]) => init?.method === `POST`)?.[1]?.body)) as {
            messages: { role: string; content: unknown }[];
        };
        const withImages = sent.messages.filter(
            (message) => Array.isArray(message.content) && message.content.some((part) => part.type === `image_url`),
        );
        // The image still reaches the model, and only from the one role that may carry it.
        expect(withImages).toHaveLength(1);
        expect(withImages.every((message) => message.role === `user`)).toBe(true);
        unstubAllGlobals();
    });

    // Quotas are per model, so Flash's window closing says nothing about Lite.
    it("falls to the next model when the first is out of quota on every key", async () => {
        const { prisma, spent } = fakePrisma();
        const asked: string[] = [];
        const fetchFn = jest.fn(async (_url: string, init?: RequestInit) => {
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
        stubGlobal(`fetch`, fetchFn);

        const response = await chat(baseConfig, prisma);

        expect(response.status).toBe(200);
        // Both keys tried on the exhausted model before the next rung, not a key sidelined for one model's quota.
        expect(asked).toEqual([`gemini-flash-latest`, `gemini-flash-latest`, `gemini-flash-lite-latest`]);
        expect(response.headers.get(`x-intentic-trial-model`)).toBe(`gemini-flash-lite-latest`);
        // Billed once, for the message the user actually got, not once per rung tried.
        expect(spent()).toBe(1);
        unstubAllGlobals();
    });

    // Discovery may only remove rungs we named, never add ones we didn't: a retired model stops being used without a
    // release, but an unvetted family can't reach a user by appearing in a catalog.
    it("stops routing to a rung the upstream has retired", async () => {
        const { prisma } = fakePrisma();
        // Flash is missing from the listing; only Lite remains of the ladder.
        const fetchFn = upstream([`gemini-flash-lite-latest`, `deep-research-max-preview-01`]);
        stubGlobal(`fetch`, fetchFn);

        // One app across both messages: the ladder's cache lives on the route instance, so a fresh app per request
        // would never exercise the veto.
        const app = createApp(baseConfig, prisma, logger).app;
        const headers = { authorization: `Bearer tok`, "content-type": `application/json` };
        const send = () => app.request(`/trial/v1/chat/completions`, { method: `POST`, headers, body: `{"model":"auto"}` });

        // First message answers from the unfiltered ladder and kicks off the capability read in the background; the
        // veto only lands on the next one.
        await send();
        await waitFor(() => expect(fetchFn.mock.calls.some(([, init]) => (init as RequestInit | undefined)?.method !== `POST`)).toBe(true));
        const before = chatPosts(fetchFn).length;
        const response = await send();

        expect(response.status).toBe(200);
        // The surviving rung, never the chat-capable model we never vetted, however loudly the upstream declares it.
        expect(
            chatPosts(fetchFn)
                .slice(before)
                .map(([, init]) => JSON.parse(String((init as RequestInit).body)).model),
        ).toEqual([`gemini-flash-lite-latest`]);
        unstubAllGlobals();
    });

    // Replaces the curated ladder wholesale; can't be filtered against Google's vocabulary since it's meant for ids
    // we've never heard of.
    it("routes to the operator's models when TRIAL_MODELS names some", async () => {
        const { prisma } = fakePrisma();
        const fetchFn = upstream([`gemini-flash-latest`]);
        stubGlobal(`fetch`, fetchFn);

        const response = await call(configWith({ models: `my-own-model` }), prisma, `/trial/v1/chat/completions`, {
            method: `POST`,
            body: `{"model":"auto"}`,
        });

        expect(response.status).toBe(200);
        const sent = fetchFn.mock.calls.find(([, init]) => init?.method === `POST`)?.[1];
        expect(JSON.parse(String(sent?.body))).toEqual({ model: `my-own-model` });
        unstubAllGlobals();
    });

    it("reads a pasted `#` note as the blank setting it annotates, not as a model", async () => {
        const { prisma } = fakePrisma();
        const fetchFn = upstream([`gemini-flash-latest`]);
        stubGlobal(`fetch`, fetchFn);

        const models = `# optional allowlist; empty = whatever upstream serves`;
        const response = await call(configWith({ models }), prisma, `/trial/v1/chat/completions`, { method: `POST`, body: `{"model":"auto"}` });

        expect(response.status).toBe(200);
        const sent = fetchFn.mock.calls.find(([, init]) => init?.method === `POST`)?.[1];
        // Falls back to the curated ladder; the comment text itself is not something any upstream would answer for.
        expect(JSON.parse(String(sent?.body))).toEqual({ model: `gemini-flash-latest` });
        unstubAllGlobals();
    });

    // Can't ride the chat response: the sandbox's translator sits between us and drops headers, so the status poll it
    // already makes is the channel.
    it("remembers which model served, and reports it on the status read", async () => {
        const { prisma } = fakePrisma();
        stubGlobal(`fetch`, upstream([`gemini-flash-latest`]));

        await chat(baseConfig, prisma);
        const status = await call(baseConfig, prisma, `/trial/status`);

        expect(await status.json()).toMatchObject({ servedModel: `gemini-flash-latest` });
        unstubAllGlobals();
    });

    // One key only, so the result can't depend on where the pool's rotation happened to start.
    it("keeps a key a pasted note was glued to", async () => {
        const { prisma } = fakePrisma();
        const fetchFn = jest.fn(async (_url: string, init: RequestInit) =>
            (init.headers as Record<string, string>)[`authorization`] === `Bearer k1`
                ? new Response(`{}`, { status: 200, headers: { "content-type": `application/json` } })
                : new Response(`{"error":"invalid api key"}`, { status: 401, headers: { "content-type": `application/json` } }),
        );
        stubGlobal(`fetch`, fetchFn);

        const config = configWith({ keys: `k1   # comma-separated Google AI Studio keys; empty = no trial at all` });
        const response = await chat(config, prisma);

        expect(response.status).toBe(200);
        unstubAllGlobals();
    });
});

/* THE FINISH-THE-TURN GRACE. Twelve calls is less than one small task, so the first one stopped mid-edit (onboarding
 * review 2026-10-18, F01). A turn the daemon opens while a step is left may finish past the allowance, within a daily
 * cap: the cost of the grace is what is pinned here, as much as the grace itself. */
describe("the finish-the-turn grace", () => {
    const graceConfig = configWith({ graceSteps: 3 });
    const turn = (config: Config, prisma: PrismaClient, state: `open` | `close`) =>
        call(config, prisma, `/trial/turn`, { method: `POST`, body: JSON.stringify({ state }) });
    const answering = () => jest.fn(async () => new Response(`{"choices":[]}`, { status: 200, headers: { "content-type": `application/json` } }));

    it("lets a turn opened with a step left run past the allowance, up to the day's grace and no further", async () => {
        const { prisma, graceSpent } = fakePrisma({ used: 1 });
        stubGlobal(`fetch`, answering());

        expect(await (await turn(graceConfig, prisma, `open`)).json()).toEqual({ grace: true });
        // The allowance's last step, three of grace, then the wall.
        const statuses = [
            (await chat(graceConfig, prisma)).status,
            (await chat(graceConfig, prisma)).status,
            (await chat(graceConfig, prisma)).status,
            (await chat(graceConfig, prisma)).status,
            (await chat(graceConfig, prisma)).status,
        ];

        expect(statuses).toEqual([200, 200, 200, 200, 429]);
        expect(graceSpent()).toBe(3);
        expect(await (await call(graceConfig, prisma, `/trial/status`)).json()).toMatchObject({ remaining: 0, grace: 0 });
        unstubAllGlobals();
    });

    it("earns nothing for a turn that opens with the allowance already spent", async () => {
        const { prisma, graceSpent } = fakePrisma({ used: 2 });
        stubGlobal(`fetch`, answering());

        expect(await (await turn(graceConfig, prisma, `open`)).json()).toEqual({ grace: false });
        expect((await chat(graceConfig, prisma)).status).toBe(429);
        expect(graceSpent()).toBe(0);
        unstubAllGlobals();
    });

    it("ends with its turn, so the next turn can't ride it", async () => {
        const { prisma } = fakePrisma({ used: 1 });
        stubGlobal(`fetch`, answering());

        await turn(graceConfig, prisma, `open`);
        expect((await chat(graceConfig, prisma)).status).toBe(200);
        expect(await (await turn(graceConfig, prisma, `close`)).json()).toEqual({ grace: false });

        expect((await chat(graceConfig, prisma)).status).toBe(429);
        unstubAllGlobals();
    });

    it("lapses an hour after the turn opened when the daemon never closed it", async () => {
        const minutesAgo = (minutes: number) => new Date(Date.now() - minutes * 60_000);
        stubGlobal(`fetch`, answering());

        const stale = fakePrisma({ used: 2, graceOpen: 1, graceOpenedAt: minutesAgo(61) });
        expect((await chat(graceConfig, stale.prisma)).status).toBe(429);
        const running = fakePrisma({ used: 2, graceOpen: 1, graceOpenedAt: minutesAgo(59) });
        expect((await chat(graceConfig, running.prisma)).status).toBe(200);
        unstubAllGlobals();
    });

    it("gives the grace step back with the message when the call was not answered", async () => {
        const { prisma, spent, graceSpent } = fakePrisma({ used: 2, graceOpen: 1, graceOpenedAt: new Date() });
        stubGlobal(
            `fetch`,
            jest.fn(async () => new Response(`{"error":{"message":"model not supported"}}`, { status: 404 })),
        );

        expect((await chat(graceConfig, prisma)).status).toBe(404);
        expect([spent(), graceSpent()]).toEqual([2, 0]);
        unstubAllGlobals();
    });

    it("is off where the platform grants none: no turn earns it and the status names none", async () => {
        const off = configWith({ graceSteps: 0 });
        const { prisma } = fakePrisma({ used: 1 });

        expect(await (await turn(off, prisma, `open`)).json()).toEqual({ grace: false });
        expect(await (await call(off, prisma, `/trial/status`)).json()).not.toHaveProperty(`grace`);
    });
});

describe("the free-trial key pool", () => {
    it("reports healthy when the first selected key answers", async () => {
        const pool = createTrialPool(baseConfig, jest.fn(async () => new Response(`{}`, { status: 200 })) as unknown as typeof fetch);

        await pool.call(`/chat/completions`, { method: `POST`, observeHealth: true });

        expect(pool.status()).toEqual({ health: `healthy` });
    });

    it("times out a stuck key and advances to the next one", async () => {
        jest.useFakeTimers();
        try {
            const fetchFn = jest.fn((_url: string | URL | Request, init?: RequestInit) => {
                const auth = (init?.headers as Record<string, string> | undefined)?.[`authorization`];
                return auth === `Bearer k1` ? new Promise<Response>(() => {}) : Promise.resolve(new Response(`{"choices":[1]}`, { status: 200 }));
            });
            const pool = createTrialPool(baseConfig, fetchFn as unknown as typeof fetch);
            const pending = pool.call(`/chat/completions`, { method: `POST`, body: () => `{}`, observeHealth: true });

            await advanceTimersByTimeAsync(20_000);

            expect((await pending)?.response.status).toBe(200);
            expect(fetchFn).toHaveBeenCalledTimes(2);
            expect(pool.status().health).toBe(`degraded`);
        } finally {
            jest.useRealTimers();
        }
    });

    it("fails over on a rejected key and quarantines it for later calls", async () => {
        const auths: (string | undefined)[] = [];
        const fetchFn = jest.fn(async (_url: string | URL | Request, init?: RequestInit) => {
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
        const fetchFn = jest.fn(async (_url: string | URL | Request, init?: RequestInit) => {
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
        const fetchFn = jest.fn(async (_url: string | URL | Request, init?: RequestInit) =>
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
        const fetchFn = jest.fn(async (_url: string | URL | Request, init?: RequestInit) => {
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
        jest.useFakeTimers();
        try {
            const attempts: string[] = [];
            const fetchFn = jest.fn((_url: string | URL | Request, init?: RequestInit) => {
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

            await advanceTimersByTimeAsync(20_000);

            expect((await pending)?.model).toBe(`lite`);
            // One timeout only, not one per key: silence is the same fact on every credential.
            expect(attempts).toEqual([`flash`, `lite`]);
        } finally {
            jest.useRealTimers();
        }
    });

    it("skips the silent rung outright on the messages that follow", async () => {
        jest.useFakeTimers();
        try {
            const attempts: string[] = [];
            const fetchFn = jest.fn((_url: string | URL | Request, init?: RequestInit) => {
                const model = (JSON.parse(String(init?.body)) as { model: string }).model;
                attempts.push(model);
                return model === `flash` ? new Promise<Response>(() => {}) : Promise.resolve(new Response(`{"choices":[1]}`, { status: 200 }));
            });
            const pool = createTrialPool(baseConfig, fetchFn as unknown as typeof fetch);
            const send = () =>
                pool.call(`/chat/completions`, { method: `POST`, models: [`flash`, `lite`], body: (model) => JSON.stringify({ model }) });

            const first = send();
            await advanceTimersByTimeAsync(20_000);
            await first;
            attempts.length = 0;
            const second = await send();

            // The cooldown is what limits the timeout cost to the first message, not every message after it.
            expect(second?.model).toBe(`lite`);
            expect(attempts).toEqual([`lite`]);
        } finally {
            jest.useRealTimers();
        }
    });

    it("tries a cooling rung again rather than refusing when no rung is left", async () => {
        jest.useFakeTimers();
        try {
            let silent = true;
            const attempts: string[] = [];
            const fetchFn = jest.fn((_url: string | URL | Request, init?: RequestInit) => {
                attempts.push((JSON.parse(String(init?.body)) as { model: string }).model);
                return silent ? new Promise<Response>(() => {}) : Promise.resolve(new Response(`{"choices":[1]}`, { status: 200 }));
            });
            const pool = createTrialPool(baseConfig, fetchFn as unknown as typeof fetch);
            const send = () =>
                pool.call(`/chat/completions`, { method: `POST`, models: [`flash`, `lite`], body: (model) => JSON.stringify({ model }) });

            const first = send();
            await advanceTimersByTimeAsync(60_000);
            await first;
            silent = false;
            attempts.length = 0;

            // Both rungs are cooling, so the cooldown has nothing left to prefer and is ignored.
            expect((await send())?.model).toBe(`flash`);
            expect(attempts).toEqual([`flash`]);
        } finally {
            jest.useRealTimers();
        }
    });

    it("honours Retry-After when quarantining a rate-limited key", async () => {
        let at = Date.parse(`2026-08-16T00:00:00.000Z`);
        const auths: (string | undefined)[] = [];
        const fetchFn = jest.fn(async (_url: string | URL | Request, init?: RequestInit) => {
            const auth = (init?.headers as Record<string, string> | undefined)?.[`authorization`];
            auths.push(auth);
            return new Response(`{}`, auth === `Bearer k1` ? { status: 429, headers: { "retry-after": `120` } } : { status: 200 });
        });
        // SAFETY: the pool calls its fetcher as (url, init) and reads only the Response, which is all this mock takes and gives.
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
