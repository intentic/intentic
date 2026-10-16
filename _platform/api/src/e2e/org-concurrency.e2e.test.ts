import { execFile } from "node:child_process";
import { createHash, randomBytes } from "node:crypto";
import { promisify } from "node:util";
import { repoRoot } from "@intentic/constants/node";
import { PrismaClient } from "@intentic/prisma";
import { e2eTier } from "@intentic/testing/e2e";
import { PrismaPg } from "@prisma/adapter-pg";
import { call, ORPCError } from "@orpc/server";
import pino from "pino";
import { GenericContainer, type StartedTestContainer, Wait } from "testcontainers";
import { eraseAccount, OwnsOrganisationSandboxes } from "../account-erase.js";
import { configSchema, type Config } from "../config.js";
import type { OrpcContext } from "../context.js";
import { orgRoutes } from "../org/org.routes.js";
import { sandboxRoutes } from "../sandbox/sandbox.routes.js";
import { testIngressConfig } from "../testing.js";

/* THE ORGANISATION'S GUARDS UNDER CONCURRENCY, on real Postgres: two admins acting on each other at the same moment,
 * and a sandbox bound while its owner deletes it or their account is erased. Each case is raced many times over fresh
 * rows, and what is asserted is the invariant, never which request won: an organisation always keeps an admin, and a
 * sandbox is never both bound and deleted. Hermetic (Docker only). */
const tier = e2eTier(`organisations under concurrent admins, binds, deletes and erasures, on real Postgres`, { enabledBy: `INTENTIC_E2E_HERMETIC` });

const exec = promisify(execFile);

// The pin the platform's own compose file and migrations job run, so the guard matches production's database.
const POSTGRES_IMAGE = `postgres:18.6-alpine3.24`;
// How many times each race is run. Every round is a fresh pair of transactions racing from the same start, so a guard
// that reads and then writes outside one lock loses a good share of them.
const ROUNDS = 25;

const logger = pino({ level: `silent` });

interface Person {
    readonly id: string;
    readonly email: string;
}

// What a raced request ended as: done, or refused with an oRPC code; anything else fails the suite as itself.
type Outcome = { readonly ok: true } | { readonly ok: false; readonly code: string };
const outcome = (settled: PromiseSettledResult<unknown>): Outcome => {
    if (settled.status === `fulfilled`) {
        return { ok: true };
    }
    if (settled.reason instanceof ORPCError) {
        return { ok: false, code: settled.reason.code };
    }
    if (settled.reason instanceof OwnsOrganisationSandboxes) {
        return { ok: false, code: `OWNS_ORGANISATION_SANDBOXES` };
    }
    throw settled.reason;
};

// A bind raced against `other`, settled in that order. One is started a few milliseconds after the other, which one
// alternating by round and the gap varying with it: a delete or an erase reads the row before it locks it, so started
// together the bind nearly always reaches the lock first, and the path where it waits behind the other would go
// unraced. The invariant is checked over both orders; which one a round took is never asserted.
const raced = async <A, B>(round: number, bind: () => Promise<A>, other: () => Promise<B>): Promise<[PromiseSettledResult<A>, PromiseSettledResult<B>]> => {
    const gap = (): Promise<void> => new Promise((resolve) => setTimeout(resolve, round % 5));
    if (round % 2 === 0) {
        const binding = bind();
        await gap();
        return Promise.allSettled([binding, other()]);
    }
    const first = other();
    await gap();
    return Promise.allSettled([bind(), first]);
};

describe.skipIf(!tier.runs)(tier.title, () => {
    let container: StartedTestContainer | undefined;
    let prisma: PrismaClient;
    let config: Config;
    let seq = 0;

    const person = async (name: string): Promise<Person> => {
        seq += 1;
        const id = `e2e-${name}-${seq}`;
        const email = `${name}-${seq}@e2e.intentic.dev`;
        await prisma.user.create({ data: { id, email, name, emailVerified: true } });
        return { id, email };
    };
    const as = (who: Person): OrpcContext =>
        // SAFETY: the org and sandbox routes read prisma, config, user and logger; nothing here reaches auth or headers.
        ({ prisma, config, logger, user: { id: who.id, email: who.email, name: who.id, image: null, emailVerified: true } }) as OrpcContext;
    const sandboxOf = async (owner: Person): Promise<string> => {
        const token = randomBytes(16).toString(`base64url`);
        const digest = createHash(`sha256`).update(token).digest(`hex`);
        const sandbox = await prisma.sandbox.create({
            data: { name: `box-${seq}`, ownerId: owner.id, token, tokenDigest: digest, tunnelId: digest.slice(0, 12) },
            select: { id: true },
        });
        return sandbox.id;
    };
    const orgWithAdmins = async (...admins: readonly Person[]): Promise<string> => {
        const org = await prisma.organisation.create({
            data: { name: `Urząd ${seq}`, members: { create: admins.map((admin) => ({ email: admin.email.toLowerCase(), role: `admin` })) } },
            select: { id: true },
        });
        return org.id;
    };
    const adminCount = (orgId: string) => prisma.orgMember.count({ where: { orgId, role: `admin` } });

    beforeAll(async () => {
        container = await new GenericContainer(POSTGRES_IMAGE)
            .withEnvironment({ POSTGRES_USER: `app`, POSTGRES_PASSWORD: `app`, POSTGRES_DB: `app`, POSTGRES_INITDB_ARGS: `--no-sync` })
            .withExposedPorts(5432)
            .withWaitStrategy(Wait.forLogMessage(/database system is ready to accept connections/, 2))
            .start();
        const databaseUrl = `postgresql://app:app@${container.getHost()}:${container.getMappedPort(5432)}/app`;
        await exec(`pnpm`, [`--filter`, `@intentic/prisma`, `migrate:deploy`], {
            cwd: repoRoot(import.meta.url),
            env: { ...process.env, DATABASE_URL: databaseUrl },
        });
        config = configSchema.parse({
            database: { url: databaseUrl, poolMax: 10 },
            betterAuth: { secret: `org-concurrency-e2e-secret` },
            secrets: { key: `` },
            webOrigin: `https://app.test`,
            ingress: testIngressConfig,
            orgs: { creation: `anyone` },
        });
        prisma = new PrismaClient({ adapter: new PrismaPg({ connectionString: databaseUrl, max: 10 }) });
    }, 240_000);

    afterAll(async () => {
        await prisma?.$disconnect();
        await container?.stop();
    });

    it(`two admins removing each other at once leave one admin, never none`, async () => {
        for (let round = 0; round < ROUNDS; round++) {
            // each round is one race over its own fresh rows
            const [a, b] = await Promise.all([person(`a`), person(`b`)]);
            // as above
            const orgId = await orgWithAdmins(a, b);
            // as above
            const settled = await Promise.allSettled([
                call(orgRoutes.removeMember, { orgId, email: b.email }, { context: as(a) }),
                call(orgRoutes.removeMember, { orgId, email: a.email }, { context: as(b) }),
            ]);
            const done = settled.map(outcome).filter((result) => result.ok);
            // as above
            expect({ round, admins: await adminCount(orgId), done: done.length }).toEqual({ round, admins: 1, done: 1 });
        }
    }, 120_000);

    it(`two admins demoting each other at once leave one admin, never none`, async () => {
        for (let round = 0; round < ROUNDS; round++) {
            // each round is one race over its own fresh rows
            const [a, b] = await Promise.all([person(`a`), person(`b`)]);
            // as above
            const orgId = await orgWithAdmins(a, b);
            // as above
            const settled = await Promise.allSettled([
                call(orgRoutes.addMember, { orgId, email: b.email, role: `member` }, { context: as(a) }),
                call(orgRoutes.addMember, { orgId, email: a.email, role: `member` }, { context: as(b) }),
            ]);
            const done = settled.map(outcome).filter((result) => result.ok);
            // as above
            expect({ round, admins: await adminCount(orgId), done: done.length }).toEqual({ round, admins: 1, done: 1 });
        }
    }, 120_000);

    it(`a sandbox bound while its owner deletes it ends up either bound or deleted, never deleted while bound`, async () => {
        for (let round = 0; round < ROUNDS; round++) {
            // each round is one race over its own fresh rows
            const owner = await person(`owner`);
            // as above
            const [orgId, sandboxId] = await Promise.all([orgWithAdmins(owner), sandboxOf(owner)]);
            const [bind, remove] = (
                // as above
                await raced(
                    round,
                    () => call(orgRoutes.bindSandbox, { orgId, sandboxId }, { context: as(owner) }),
                    () => call(sandboxRoutes.delete, { sandboxId }, { context: as(owner) }),
                )
            ).map(outcome);
            // as above
            const row = await prisma.sandbox.findUnique({ where: { id: sandboxId }, select: { orgId: true } });
            // Exactly one of the two took effect, and the database says the same thing the answers did.
            expect({ round, bound: bind?.ok, deleted: remove?.ok, row }).toEqual(
                bind?.ok === true ? { round, bound: true, deleted: false, row: { orgId } } : { round, bound: false, deleted: true, row: null },
            );
        }
    }, 120_000);

    it(`the database refuses to delete a bound sandbox by any path, an account row's cascade included, until it is released`, async () => {
        const owner = await person(`owner`);
        const [orgId, sandboxId] = await Promise.all([orgWithAdmins(owner), sandboxOf(owner)]);
        await call(orgRoutes.bindSandbox, { orgId, sandboxId }, { context: as(owner) });
        // What no route can stop: the account row deleted after its erase committed, which cascades to its sandboxes.
        // A PrismaPromise is lazy and no Promise, so each is started with `then` for `rejects` to read.
        await expect(prisma.user.delete({ where: { id: owner.id } }).then(() => `deleted`)).rejects.toThrow(/belongs to an organisation/u);
        await expect(prisma.sandbox.delete({ where: { id: sandboxId } }).then(() => `deleted`)).rejects.toThrow(/belongs to an organisation/u);
        expect(await prisma.sandbox.findUnique({ where: { id: sandboxId }, select: { orgId: true } })).toEqual({ orgId });
        await call(orgRoutes.unbindSandbox, { orgId, sandboxId }, { context: as(owner) });
        await prisma.user.delete({ where: { id: owner.id } });
        expect(await prisma.sandbox.findUnique({ where: { id: sandboxId } })).toBeNull();
    });

    it(`a sandbox bound while its owner's account is erased ends up either bound with the account kept, or gone`, async () => {
        for (let round = 0; round < ROUNDS; round++) {
            // each round is one race over its own fresh rows
            const owner = await person(`leaver`);
            // as above
            const [orgId, sandboxId] = await Promise.all([orgWithAdmins(owner), sandboxOf(owner)]);
            const [bind, erase] = (
                // as above
                await raced(
                    round,
                    () => call(orgRoutes.bindSandbox, { orgId, sandboxId }, { context: as(owner) }),
                    () => eraseAccount(prisma, config, logger, owner.id),
                )
            ).map(outcome);
            // as above
            const row = await prisma.sandbox.findUnique({ where: { id: sandboxId }, select: { orgId: true } });
            expect({ round, bound: bind?.ok, erased: erase?.ok, row }).toEqual(
                bind?.ok === true ? { round, bound: true, erased: false, row: { orgId } } : { round, bound: false, erased: true, row: null },
            );
        }
    }, 120_000);
});
