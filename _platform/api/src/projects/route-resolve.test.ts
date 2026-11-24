import { createHash } from "node:crypto";
import type { PrismaClient } from "@intentic/prisma";
import { verifySandboxPass } from "@intentic/sandbox-contract/sandbox-pass";
import { Hono } from "hono";
import { type Logger, pino } from "pino";
import { z } from "zod";
import { type Config, configSchema } from "../config.js";
import { identityKeyOf } from "../sign-in.js";
import { projectsHttpRoutes } from "./projects.routes.js";

// Routing as a person: the asking sandbox may only name its own people, toward sandboxes those people already reach,
// whoever owns them. Pins who counts as on a sandbox (its owner, or a member who accepted), the target found by claim or by
// name, the candidates when that is ambiguous, and the pass naming the scope and the person.

const logger: Logger = pino({ level: `silent` });
const NOW = new Date(`2026-11-24T12:00:00Z`);

const config: Config = configSchema.parse({
    database: { url: `postgres://x`, poolMax: 10 },
    betterAuth: { secret: `s` },
    secrets: { key: `` },
    webOrigin: `https://app.test`,
    google: { clientId: ``, clientSecret: `` },
    email: { apiKey: ``, from: `` },
    intenticCloudflare: { apiToken: ``, zone: `intentic.dev`, reapDryRun: `true` },
    ingress: { url: `https://ingress.sbx.test`, signingKey: `k`, zone: `sbx.test` },
    trial: { keys: ``, baseUrl: `https://upstream.test/v1beta/openai`, models: ``, dailyMessages: 2 },
    api: { url: `http://localhost:6480`, port: 6480, host: `127.0.0.1`, httpsKey: ``, httpsCert: `` },
    log: { level: `silent`, pretty: `false` },
});

const digestOf = (token: string) => createHash(`sha256`).update(token).digest(`hex`);

interface Box {
    id: string;
    ownerEmail: string;
    ownerId: string;
    tunnelId: string;
    name: string;
    daemonUrl: string | null;
    token: string;
    members: { email: string; acceptedAt: Date | null }[];
    removedAt?: Date;
    org?: { id: string; name: string };
}
const url = (tunnel: string) => `https://sandbox-${tunnel}.sbx.test`;
// Ada owns ops and app; Bob owns billing and lab, and gave Ada a place on billing (accepted) and on lab (not accepted);
// Bob's "app" shares a name with Ada's; gone was removed.
const BOXES: Box[] = [
    { id: `s1`, ownerEmail: `ada@x.test`, ownerId: `ada`, tunnelId: `aaaaaaaaaaaa`, name: `ops`, daemonUrl: url(`aaaaaaaaaaaa`), token: `tok-ops`, members: [{ email: `cy@x.test`, acceptedAt: NOW }] },
    { id: `s2`, ownerEmail: `ada@x.test`, ownerId: `ada`, tunnelId: `bbbbbbbbbbbb`, name: `app`, daemonUrl: url(`bbbbbbbbbbbb`), token: `tok-app`, members: [] },
    {
        id: `s3`,
        ownerEmail: `bob@x.test`,
        ownerId: `bob`,
        tunnelId: `cccccccccccc`,
        name: `billing`,
        daemonUrl: url(`cccccccccccc`),
        token: `tok-billing`,
        members: [{ email: `ada@x.test`, acceptedAt: NOW }],
        org: { id: `org_acme`, name: `Acme` },
    },
    { id: `s4`, ownerEmail: `bob@x.test`, ownerId: `bob`, tunnelId: `dddddddddddd`, name: `lab`, daemonUrl: url(`dddddddddddd`), token: `tok-lab`, members: [{ email: `ada@x.test`, acceptedAt: null }] },
    { id: `s5`, ownerEmail: `bob@x.test`, ownerId: `bob`, tunnelId: `eeeeeeeeeeee`, name: `App`, daemonUrl: url(`eeeeeeeeeeee`), token: `tok-bobapp`, members: [{ email: `ada@x.test`, acceptedAt: NOW }] },
    { id: `s6`, ownerEmail: `ada@x.test`, ownerId: `ada`, tunnelId: `ffffffffffff`, name: `gone`, daemonUrl: url(`ffffffffffff`), token: `tok-gone`, members: [], removedAt: NOW },
];
const CLAIMS = [
    { ownerId: `ada`, sandboxId: `s2`, project: `github.com/acme/app` },
    { ownerId: `bob`, sandboxId: `s3`, project: `github.com/acme/billing` },
    { ownerId: `bob`, sandboxId: `s5`, project: `github.com/acme/shared` },
    { ownerId: `ada`, sandboxId: `s2`, project: `github.com/acme/shared` },
];

// The where clauses route-resolve.ts writes, read the way Postgres would: enough of prisma's filter language to run them,
// each part parsed by the shape the handler writes it in.
type Where = Record<string, unknown>;
const TextFilterSchema = z.union([z.string(), z.object({ equals: z.string(), mode: z.literal(`insensitive`) })]);
const IdFilterSchema = z.union([z.string(), z.object({ not: z.string() })]);
const MembersFilterSchema = z.object({ some: z.object({ email: TextFilterSchema, acceptedAt: z.object({ not: z.null() }) }) });
const OwnerFilterSchema = z.object({ email: TextFilterSchema });
const WhereListSchema = z.array(z.record(z.string(), z.unknown()));
const same = (left: string, raw: unknown): boolean => {
    const filter = TextFilterSchema.parse(raw);
    return filter instanceof Object ? left.toLowerCase() === filter.equals.toLowerCase() : left === filter;
};
const sameId = (id: string, raw: unknown): boolean => {
    const filter = IdFilterSchema.parse(raw);
    return filter instanceof Object ? id !== filter.not : id === filter;
};
const matches = (box: Box, where: Where): boolean =>
    Object.entries(where).every(([key, value]) => {
        switch (key) {
            case `OR`:
                return WhereListSchema.parse(value).some((part) => matches(box, part));
            case `AND`:
                return WhereListSchema.parse(value).every((part) => matches(box, part));
            case `id`:
                return sameId(box.id, value);
            case `tokenDigest`:
                return digestOf(box.token) === value;
            case `removedAt`:
                return (box.removedAt ?? null) === value;
            case `tunnelId`:
                return box.tunnelId === value;
            case `name`:
                return same(box.name, value);
            case `owner`:
                return same(box.ownerEmail, OwnerFilterSchema.parse(value).email);
            case `members`: {
                const { some } = MembersFilterSchema.parse(value);
                return box.members.some((member) => same(member.email, some.email) && member.acceptedAt !== null);
            }
            default:
                throw new Error(`the fake does not read ${key}`);
        }
    });
const target = (box: Box) => ({ id: box.id, tunnelId: box.tunnelId, name: box.name, daemonUrl: box.daemonUrl, org: box.org ?? null });

// SAFETY: only the delegates route-resolve.ts calls, each answering in the shape its `select` asks for.
const fakePrisma = (): PrismaClient =>
    ({
        sandbox: {
            findFirst: async ({ where }: { where: Where }) => {
                const box = BOXES.find((row) => matches(row, where));
                return box === undefined ? null : { id: box.id, ownerId: box.ownerId, tunnelId: box.tunnelId, name: box.name, org: box.org ?? null };
            },
            findUnique: async () => null,
            count: async ({ where }: { where: Where }) => BOXES.filter((row) => matches(row, where)).length,
            findMany: async ({ where }: { where: Where }) => BOXES.filter((row) => matches(row, where)).map(target),
        },
        projectClaim: {
            findMany: async ({ where }: { where: { ownerId?: string; project: string; sandbox?: Where } }) =>
                CLAIMS.filter((claim) => claim.project === where.project && (where.ownerId === undefined || claim.ownerId === where.ownerId))
                    .map((claim) => BOXES.find((row) => row.id === claim.sandboxId))
                    .filter((box): box is Box => box !== undefined && (where.sandbox === undefined || matches(box, where.sandbox)))
                    .map((box) => ({ sandbox: target(box) })),
        },
    }) as never;

const AnswerSchema = z.record(z.string(), z.unknown());

const client = () => {
    const host = new Hono<{ Variables: { logger: Logger } }>();
    host.use(async (c, next) => {
        c.set(`logger`, logger);
        await next();
    });
    host.route(`/projects`, projectsHttpRoutes({ config, prisma: fakePrisma(), now: () => NOW }));
    return async (token: string, body: unknown) => {
        const headers = new Headers({ "content-type": `application/json`, "x-intentic-connect": token });
        const response = await host.request(`/projects/route`, { method: `POST`, headers, body: JSON.stringify(body) });
        return { status: response.status, body: AnswerSchema.parse(await response.json()) };
    };
};
const passOf = (body: Record<string, unknown>) => verifySandboxPass(identityKeyOf(config), String(body[`pass`]), NOW.getTime());

describe(`routing as a person`, () => {
    it(`reaches another owner's sandbox the person accepted a place on, and the pass says the scope and the person`, async () => {
        const answer = await client()(`tok-ops`, { scope: `drop`, person: `Ada@X.test`, sandbox: `billing` });
        expect(answer.status).toBe(200);
        expect(answer.body).toMatchObject({ scope: `drop`, sandboxId: `cccccccccccc`, name: `billing`, crossesOrg: { to: { id: `org_acme`, name: `Acme` } } });
        expect(answer.body).not.toHaveProperty(`project`);
        expect(passOf(answer.body)).toMatchObject({ from: `aaaaaaaaaaaa`, to: `cccccccccccc`, scope: `drop`, person: `ada@x.test` });
    });

    it(`refuses a person who is not on the asking sandbox, and a place never accepted`, async () => {
        const call = client();
        expect((await call(`tok-app`, { scope: `read`, person: `cy@x.test`, sandbox: `ops` })).status).toBe(403);
        expect((await call(`tok-ops`, { scope: `read`, person: `ada@x.test`, sandbox: `lab` })).status).toBe(404);
        expect((await call(`tok-ops`, { scope: `read`, person: `cy@x.test`, sandbox: `billing` })).status).toBe(404);
    });

    it(`names a sandbox by id when two the person is in share a name, and never a removed one`, async () => {
        const call = client();
        const both = await call(`tok-ops`, { scope: `task`, person: `ada@x.test`, sandbox: `app` });
        expect(both.status).toBe(409);
        expect(both.body[`candidates`]).toEqual([
            { sandboxId: `bbbbbbbbbbbb`, name: `app` },
            { sandboxId: `eeeeeeeeeeee`, name: `App` },
        ]);
        expect((await call(`tok-ops`, { scope: `task`, person: `ada@x.test`, sandbox: `eeeeeeeeeeee` })).body).toMatchObject({ name: `App` });
        expect((await call(`tok-ops`, { scope: `task`, person: `ada@x.test`, sandbox: `gone` })).status).toBe(404);
    });

    it(`finds a report's sandbox by claim among those the person reaches, across owners, or asks which`, async () => {
        const call = client();
        const billing = await call(`tok-ops`, { scope: `report`, person: `ada@x.test`, project: `https://github.com/acme/billing.git` });
        expect(billing.body).toMatchObject({ scope: `report`, project: `github.com/acme/billing`, sandboxId: `cccccccccccc` });
        expect(passOf(billing.body)).toMatchObject({ scope: `report`, project: `github.com/acme/billing`, person: `ada@x.test` });
        const shared = await call(`tok-ops`, { scope: `report`, person: `ada@x.test`, project: `github.com/acme/shared` });
        expect(shared.status).toBe(409);
        expect(shared.body[`candidates`]).toHaveLength(2);
    });

    it(`keeps a report with no person to the asking sandbox's owner's own claims`, async () => {
        const call = client();
        expect((await call(`tok-ops`, { scope: `report`, project: `github.com/acme/app` })).body).toMatchObject({ sandboxId: `bbbbbbbbbbbb` });
        expect((await call(`tok-ops`, { scope: `report`, project: `github.com/acme/billing` })).status).toBe(404);
    });

    it(`refuses an ask that routes as nobody, names no target, or carries a project outside a report`, async () => {
        const call = client();
        expect((await call(`tok-ops`, { scope: `drop`, sandbox: `billing` })).status).toBe(400);
        expect((await call(`tok-ops`, { scope: `drop`, person: `ada@x.test` })).status).toBe(400);
        expect((await call(`tok-ops`, { scope: `drop`, person: `ada@x.test`, sandbox: `billing`, project: `github.com/a/b` })).status).toBe(400);
        expect((await call(`tok-ops`, { scope: `report` })).status).toBe(400);
        expect((await call(`tok-nobody`, { scope: `report`, project: `github.com/acme/app` })).status).toBe(404);
    });
});
