import { createHash } from "node:crypto";
import type { PrismaClient } from "@intentic/prisma";
import type { Logger } from "pino";
import { expect, it, vi } from "vitest";
import { type Config, configSchema } from "../config.js";
import { testIngressConfig } from "../testing.js";
import { fleetHttpRoutes } from "./fleet.routes.js";

// The provisioning door is the only way into this account that is not a browser, so what it refuses matters more than
// what it does: a revoked token, a runaway loop, and the hosted lane it must never reach.

const logger = { child: () => logger, info: vi.fn(), warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
const NOW = new Date(`2026-09-21T12:00:00Z`);

const config: Config = configSchema.parse({
    database: { url: `postgres://x`, poolMax: 10 },
    betterAuth: { secret: `s` },
    // Set, because minting a claim encrypts its payload with it; an empty key is a different test than this one.
    secrets: { key: `0`.repeat(64) },
    webOrigin: `https://app.test`,
    google: { clientId: ``, clientSecret: `` },
    email: { apiKey: ``, from: `` },
    intenticCloudflare: { apiToken: ``, zone: `intentic.dev`, reapDryRun: `true` },
    // A real Ed25519 key: minting a claim signs a reachability grant with it, so a placeholder would fail the one
    // path under test rather than exercising it.
    ingress: testIngressConfig,
    trial: { keys: ``, baseUrl: `https://upstream.test/v1beta/openai`, models: ``, dailyMessages: 2 },
    wallet: { custodyUrl: ``, custodyKey: `` },
    api: { url: `http://localhost:6480`, port: 6480, host: `127.0.0.1`, httpsKey: ``, httpsCert: `` },
    log: { level: `silent`, pretty: `false` },
});

const digestOf = (token: string) => createHash(`sha256`).update(token).digest(`hex`);

const LIVE_TOKEN = `itk_live`;

interface Seed {
    readonly revoked?: boolean;
    readonly scope?: string;
    readonly recentSandboxes?: number;
}

const fakePrisma = (seed: Seed = {}) => {
    const created: Record<string, unknown>[] = [];
    const deleted: string[] = [];
    const updates: Record<string, unknown>[] = [];
    const prisma = {
        apiToken: {
            findUnique: vi.fn(async ({ where }: { where: { hash: string } }) =>
                where.hash === digestOf(LIVE_TOKEN)
                    ? {
                          id: `tok-1`,
                          userId: `user-1`,
                          label: `fleet`,
                          scope: seed.scope ?? `provision`,
                          revokedAt: seed.revoked === true ? NOW : null,
                          lastUsedAt: null,
                          user: { email: `owner@example.test` },
                      }
                    : null,
            ),
            update: vi.fn(async () => ({})),
        },
        sandbox: {
            count: vi.fn(async () => seed.recentSandboxes ?? 0),
            findMany: vi.fn(async () => [
                { id: `sbx-1`, name: `storefront`, daemonUrl: `https://storefront.sbx.test`, lastSeenAt: NOW },
                { id: `sbx-2`, name: `never-came-up`, daemonUrl: null, lastSeenAt: null },
            ]),
            create: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
                created.push(data);
                return { id: `sbx-new`, name: data[`name`], token: data[`token`], setupCode: null, setupCodeExpiresAt: null, setupPayload: null, hosted: null };
            }),
            update: vi.fn(async ({ data }: { data: Record<string, unknown> }) => {
                updates.push(data);
                return {};
            }),
            delete: vi.fn(async ({ where }: { where: { id: string } }) => {
                deleted.push(where.id);
                return {};
            }),
        },
    };
    return { prisma: prisma as unknown as PrismaClient, created, deleted, updates };
};

const app = (prisma: PrismaClient, over: Partial<Config> = {}) => {
    const routes = fleetHttpRoutes({ config: { ...config, ...over }, prisma, now: () => NOW });
    return (path: string, init: { method?: string; body?: unknown; token?: string } = {}) =>
        routes.request(path, {
            method: init.method ?? `GET`,
            headers: {
                "content-type": `application/json`,
                ...(init.token === null ? {} : { authorization: `Bearer ${init.token ?? LIVE_TOKEN}` }),
            },
            ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
        });
};

it(`names the account a live token belongs to`, async () => {
    const { prisma } = fakePrisma();
    const response = await app(prisma)(`/whoami`);
    expect(response.status).toBe(200);
    await expect(response.json()).resolves.toEqual({ email: `owner@example.test`, label: `fleet` });
});

it(`refuses a revoked token, a token of another scope, and no token at all`, async () => {
    const revoked = await app(fakePrisma({ revoked: true }).prisma)(`/whoami`);
    expect(revoked.status).toBe(401);

    // A token minted for something else is not a provisioning token, whatever else it can do.
    const wrongScope = await app(fakePrisma({ scope: `something-else` }).prisma)(`/whoami`);
    expect(wrongScope.status).toBe(401);

    const unknown = await app(fakePrisma().prisma)(`/whoami`, { token: `itk_never_existed` });
    expect(unknown.status).toBe(401);
});

it(`lists the account's sandboxes, and says nothing about a box that never announced`, async () => {
    const { prisma } = fakePrisma();
    const body = (await (await app(prisma)(`/sandboxes`)).json()) as { sandboxes: Record<string, unknown>[] };
    expect(body.sandboxes[0]).toEqual({ id: `sbx-1`, name: `storefront`, url: `https://storefront.sbx.test`, lastSeenAt: NOW.toISOString() });
    // Absent, not null and not empty-string: a box that never came up has no address, which is a different fact.
    expect(body.sandboxes[1]).toEqual({ id: `sbx-2`, name: `never-came-up` });
});

it(`provisions a row and a claim, seeding the definition it was handed`, async () => {
    const { prisma, created, updates } = fakePrisma();
    const response = await app(prisma)(`/provision`, { method: `POST`, body: { name: `  reviewer  `, definition: `[workspace]\nremote = "git@x:y.git"\n` } });
    expect(response.status).toBe(200);
    const body = (await response.json()) as { sandboxId: string; name: string; setupCode: string };
    expect(body).toMatchObject({ sandboxId: `sbx-new`, name: `reviewer` });
    expect(body.setupCode.length).toBeGreaterThan(8);
    // The name is trimmed at the door, so the switcher never shows the caller's whitespace.
    expect(created[0]?.[`name`]).toBe(`reviewer`);
    // The claim carries the code and an encrypted payload; the definition rides inside that payload, never in the clear.
    expect(updates[0]).toMatchObject({ setupCode: body.setupCode, setupCodeClaimedAt: null });
    expect(JSON.stringify(updates[0])).not.toContain(`git@x:y.git`);
});

it(`refuses an eleventh sandbox in an hour rather than letting a loop fill the account`, async () => {
    const { prisma, created } = fakePrisma({ recentSandboxes: 10 });
    const response = await app(prisma)(`/provision`, { method: `POST`, body: { name: `one-more` } });
    expect(response.status).toBe(429);
    expect(created).toHaveLength(0);
});

it(`takes the row back out when no claim can be minted for it`, async () => {
    const { prisma, deleted } = fakePrisma();
    // No reachability fabric: the row would exist under a name nothing could ever connect to.
    const response = await app(prisma, { ingress: { ...config.ingress, signingKey: `` } })(`/provision`, { method: `POST`, body: { name: `orphan` } });
    expect(response.status).toBe(503);
    expect(deleted).toEqual([`sbx-new`]);
});

it(`refuses a body that is not a name`, async () => {
    const { prisma } = fakePrisma();
    expect((await app(prisma)(`/provision`, { method: `POST`, body: { name: `` } })).status).toBe(400);
    expect((await app(prisma)(`/provision`, { method: `POST`, body: { definition: `x` } })).status).toBe(400);
});
