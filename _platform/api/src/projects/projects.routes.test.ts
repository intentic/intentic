import { createHash } from "node:crypto";
import type { PrismaClient } from "@intentic/prisma";
import { verifySandboxPass } from "@intentic/sandbox-contract/sandbox-pass";
import { Hono } from "hono";
import { type Logger, pino } from "pino";
import { z } from "zod";
import { type Config, configSchema } from "../config.js";
import { identityKeyOf } from "../sign-in.js";
import { projectsHttpRoutes } from "./projects.routes.js";

// The directory is the whole fence of account-level report routing: a pass is the receiver's only proof of who is
// reporting. Pins that `from` comes from the connect token, that only the caller's own account is searched, and that a
// pass is never minted to the caller itself or to a sandbox with no address.

const logger: Logger = pino({ level: `silent` });
const NOW = new Date(`2026-11-17T12:00:00Z`);

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
    ownerId: string;
    tunnelId: string;
    name: string;
    daemonUrl: string | null;
    token: string;
    org?: { id: string; name: string };
}
const BOXES: Box[] = [
    { id: `s1`, ownerId: `ada`, tunnelId: `aaaaaaaaaaaa`, name: `ops`, daemonUrl: `https://sandbox-aaaaaaaaaaaa.sbx.test`, token: `tok-ops` },
    { id: `s2`, ownerId: `ada`, tunnelId: `bbbbbbbbbbbb`, name: `app`, daemonUrl: `https://sandbox-bbbbbbbbbbbb.sbx.test`, token: `tok-app` },
    { id: `s3`, ownerId: `ada`, tunnelId: `cccccccccccc`, name: `new`, daemonUrl: null, token: `tok-new` },
    { id: `s4`, ownerId: `eve`, tunnelId: `dddddddddddd`, name: `eve`, daemonUrl: `https://sandbox-dddddddddddd.sbx.test`, token: `tok-eve` },
    {
        id: `s5`,
        ownerId: `ada`,
        tunnelId: `eeeeeeeeeeee`,
        name: `work`,
        daemonUrl: `https://sandbox-eeeeeeeeeeee.sbx.test`,
        token: `tok-work`,
        org: { id: `org_acme`, name: `Acme` },
    },
];
const CLAIMS = [
    { ownerId: `ada`, sandboxId: `s2`, project: `github.com/acme/app` },
    { ownerId: `ada`, sandboxId: `s3`, project: `github.com/acme/fresh` },
    { ownerId: `eve`, sandboxId: `s4`, project: `github.com/eve/secret` },
    { ownerId: `ada`, sandboxId: `s5`, project: `github.com/acme/billing` },
];

// SAFETY: only the delegates projects.routes.ts calls, each answering in the shape its `select` asks for.
const fakePrisma = (): PrismaClient =>
    ({
        sandbox: {
            findUnique: jest.fn(async ({ where }: { where: { tokenDigest: string } }) => {
                const box = BOXES.find((row) => digestOf(row.token) === where.tokenDigest);
                return box === undefined ? null : { id: box.id, ownerId: box.ownerId, tunnelId: box.tunnelId, name: box.name, org: box.org ?? null };
            }),
        },
        projectClaim: {
            findUnique: jest.fn(async ({ where }: { where: { ownerId_project: { ownerId: string; project: string } } }) => {
                const key = where.ownerId_project;
                const claim = CLAIMS.find((row) => row.ownerId === key.ownerId && row.project === key.project);
                const box = BOXES.find((row) => row.id === claim?.sandboxId);
                return claim === undefined || box === undefined
                    ? null
                    : { sandbox: { id: box.id, tunnelId: box.tunnelId, name: box.name, daemonUrl: box.daemonUrl, org: box.org ?? null } };
            }),
            findMany: jest.fn(async ({ where }: { where: { sandboxId: string } }) =>
                CLAIMS.filter((row) => row.sandboxId === where.sandboxId).map((row) => ({ project: row.project })),
            ),
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
    return async (path: string, token: string | undefined, body?: unknown) => {
        const headers = new Headers({ "content-type": `application/json` });
        if (token !== undefined) {
            headers.set(`x-intentic-connect`, token);
        }
        const response = await host.request(path, { method: `POST`, headers, body: JSON.stringify(body ?? {}) });
        return { status: response.status, body: AnswerSchema.parse(await response.json()) };
    };
};

describe(`project directory`, () => {
    it(`answers the owning sandbox's address and a pass from the caller, whatever spelling the project came in`, async () => {
        const call = client();
        const answer = await call(`/projects/resolve`, `tok-ops`, { project: `git@github.com:Acme/App.git` });
        expect(answer.status).toBe(200);
        expect(answer.body).toMatchObject({ project: `github.com/acme/app`, sandboxId: `bbbbbbbbbbbb`, name: `app`, address: BOXES[1]!.daemonUrl });
        const pass = verifySandboxPass(identityKeyOf(config), String(answer.body[`pass`]), NOW.getTime());
        expect(pass).toMatchObject({ from: `aaaaaaaaaaaa`, fromName: `ops`, to: `bbbbbbbbbbbb`, project: `github.com/acme/app` });
    });

    // Crossing an organisation's line is allowed and said: in the answer, and in the pass the receiver trusts.
    it(`says when a report crosses an organisation's line, in the answer and the pass, and not otherwise`, async () => {
        const call = client();
        const into = await call(`/projects/resolve`, `tok-ops`, { project: `github.com/acme/billing` });
        expect(into.status).toBe(200);
        expect(into.body[`crossesOrg`]).toEqual({ to: { id: `org_acme`, name: `Acme` } });
        expect(verifySandboxPass(identityKeyOf(config), String(into.body[`pass`]), NOW.getTime())?.crossesOrg).toEqual({ to: { id: `org_acme`, name: `Acme` } });
        const out = await call(`/projects/resolve`, `tok-work`, { project: `github.com/acme/app` });
        expect(out.body[`crossesOrg`]).toEqual({ from: { id: `org_acme`, name: `Acme` } });
        const within = await call(`/projects/resolve`, `tok-ops`, { project: `github.com/acme/app` });
        expect(within.body).not.toHaveProperty(`crossesOrg`);
    });

    it(`never searches another account, and says which project nobody claims`, async () => {
        const call = client();
        const answer = await call(`/projects/resolve`, `tok-ops`, { project: `github.com/eve/secret` });
        expect(answer.status).toBe(404);
        expect(answer.body[`error`]).toContain(`github.com/eve/secret`);
    });

    it(`refuses an unknown token, a project that is no repository, a claim of the caller's own, and a target with no address`, async () => {
        const call = client();
        expect((await call(`/projects/resolve`, undefined, { project: `github.com/acme/app` })).status).toBe(404);
        expect((await call(`/projects/resolve`, `tok-nobody`, { project: `github.com/acme/app` })).status).toBe(404);
        expect((await call(`/projects/resolve`, `tok-ops`, { project: `app` })).status).toBe(400);
        expect((await call(`/projects/resolve`, `tok-app`, { project: `github.com/acme/app` })).status).toBe(409);
        expect((await call(`/projects/resolve`, `tok-ops`, { project: `github.com/acme/fresh` })).status).toBe(409);
    });

    it(`lists the projects the caller claims`, async () => {
        const call = client();
        expect((await call(`/projects/mine`, `tok-app`)).body).toEqual({ projects: [`github.com/acme/app`] });
        expect((await call(`/projects/mine`, `tok-ops`)).body).toEqual({ projects: [] });
    });
});
