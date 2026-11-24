import { ACCOUNT_PREFERENCES_MAX } from "@intentic/api-contract";
import type { PrismaClient } from "@intentic/prisma";
import { call } from "@orpc/server";
import type { OrpcContext } from "../context.js";
import { meRoutes } from "./me.routes.js";

/* THE ACCOUNT'S OWN PREFERENCES against an in-memory user table: read back as kept, with what no longer reads dropped
 * rather than failing the read; patched under a lock on the caller's own row; refused whole past the cap; and never
 * anybody's but the caller's. */

// SAFETY: a test double standing in for a type it implements only the part of that these routes call; a call outside
// that part fails the test loudly rather than passing.
const stand = <T>(double: object): T => double as T;

interface Row {
    preferences: unknown;
}

const world = (mine: unknown = null) => {
    const rows = new Map<string, Row>([
        [`user-1`, { preferences: mine }],
        [`user-2`, { preferences: { "ui-skin": `silver` } }],
    ]);
    const locks: string[] = [];
    const user = {
        findUnique: async ({ where }: { where: { id: string } }) => rows.get(where.id) ?? null,
        update: async ({ where, data }: { where: { id: string }; data: Row }) => {
            rows.set(where.id, { preferences: data.preferences });
            return rows.get(where.id);
        },
    };
    const tx = {
        user,
        $executeRaw: async (sql: TemplateStringsArray, ...values: readonly string[]) => {
            locks.push(`${/FROM "(\w+)"/u.exec(sql.join(``))?.[1] ?? `?`}:${values.join(`,`)}`);
            return 1;
        },
    };
    const prisma = stand<PrismaClient>({ user, $transaction: async <T>(work: (client: typeof tx) => Promise<T>): Promise<T> => work(tx) });
    return { rows, locks, prisma };
};

const as = (prisma: PrismaClient, id: string | null = `user-1`): OrpcContext =>
    stand<OrpcContext>({
        prisma,
        user: id === null ? null : { id, email: `${id}@x.test`, name: id, image: null, emailVerified: true },
        logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
    });

describe(`me.preferences`, () => {
    it(`reads an account that kept nothing, or something that is not a set, as no preferences`, async () => {
        for (const kept of [null, [`ui-skin`], `silver`]) {
            const { prisma } = world(kept);
            expect(await call(meRoutes.preferences, undefined, { context: as(prisma) })).toEqual({ values: {} });
        }
    });

    it(`drops an entry that no longer reads and keeps every other one`, async () => {
        const { prisma } = world({ "ui-skin": `silver`, "Not a name": `x`, "ui-text-size": 5, "ui-locale": `x`.repeat(600), "ui-motion": `off` });
        expect(await call(meRoutes.preferences, undefined, { context: as(prisma) })).toEqual({ values: { "ui-skin": `silver`, "ui-motion": `off` } });
    });

    it(`answers nobody who is not signed in`, async () => {
        const { prisma } = world();
        await expect(call(meRoutes.preferences, undefined, { context: as(prisma, null) })).rejects.toMatchObject({ code: `UNAUTHORIZED` });
    });
});

describe(`me.setPreferences`, () => {
    it(`sets and removes what the patch names, keeps the rest, and touches only the caller's row`, async () => {
        const { prisma, rows, locks } = world({ "ui-skin": `silver`, "ui-color-scheme": `dark`, "ui-locale": `pl` });
        const answered = await call(
            meRoutes.setPreferences,
            { values: { "ui-color-scheme": `light`, "ui-skin": null, "ui-wallpaper": `dunes` } },
            { context: as(prisma) },
        );
        const expected = { "ui-color-scheme": `light`, "ui-locale": `pl`, "ui-wallpaper": `dunes` };
        expect(answered).toEqual({ values: expected });
        expect(rows.get(`user-1`)?.preferences).toEqual(expected);
        expect(rows.get(`user-2`)?.preferences).toEqual({ "ui-skin": `silver` });
        // Merged under the row's own lock, so a second device's save waits for this one rather than writing over it.
        expect(locks).toEqual([`user:user-1`]);
    });

    it(`starts an account that kept nothing from an empty set`, async () => {
        const { prisma } = world(null);
        expect(await call(meRoutes.setPreferences, { values: { "ui-motion": `off` } }, { context: as(prisma) })).toEqual({
            values: { "ui-motion": `off` },
        });
    });

    it(`refuses a patch that would pass the cap whole, and still takes one that replaces at it`, async () => {
        const full = Object.fromEntries(Array.from({ length: ACCOUNT_PREFERENCES_MAX }, (_, n) => [`ui-pref-${n}`, `${n}`]));
        const { prisma, rows } = world(full);
        await expect(
            call(meRoutes.setPreferences, { values: { "ui-one-more": `x`, "ui-pref-0": `changed` } }, { context: as(prisma) }),
        ).rejects.toMatchObject({
            code: `BAD_REQUEST`,
        });
        expect(rows.get(`user-1`)?.preferences).toEqual(full);
        const replaced = await call(meRoutes.setPreferences, { values: { "ui-pref-0": `changed` } }, { context: as(prisma) });
        expect(replaced.values[`ui-pref-0`]).toBe(`changed`);
        expect(Object.keys(replaced.values)).toHaveLength(ACCOUNT_PREFERENCES_MAX);
    });

    it(`refuses a name the editor would never store, and anybody not signed in`, async () => {
        const { prisma } = world();
        await expect(call(meRoutes.setPreferences, { values: { "Not a name": `x` } }, { context: as(prisma) })).rejects.toMatchObject({
            code: `BAD_REQUEST`,
        });
        await expect(call(meRoutes.setPreferences, { values: { "ui-skin": `none` } }, { context: as(prisma, null) })).rejects.toMatchObject({
            code: `UNAUTHORIZED`,
        });
    });
});

describe(`me.get`, () => {
    const signedIn = (email: string, lists: { admins?: string; internal?: string }): OrpcContext =>
        stand<OrpcContext>({
            prisma: stand<PrismaClient>({ account: { count: async () => 0 } }),
            user: { id: `user-1`, email, name: `One`, image: null, emailVerified: true },
            config: {
                admin: { emails: lists.admins ?? `` },
                hosted: { canaryEmail: `` },
                telemetry: { internalAccounts: lists.internal ?? `` },
                signIn: { email: false },
                email: { apiKey: ``, from: `` },
            },
            logger: { info: jest.fn(), warn: jest.fn(), error: jest.fn() },
        });

    it(`says whether the caller is one of the team's accounts, and nothing of the list it read that from`, async () => {
        const lists = { admins: `owner@example.com`, internal: `@team.example,qa@tester.dev` };
        const owner = await call(meRoutes.get, undefined, { context: signedIn(`owner@example.com`, lists) });
        expect(owner?.internal).toBe(true);
        expect(JSON.stringify(owner)).not.toContain(`team.example`);
        expect(JSON.stringify(owner)).not.toContain(`tester.dev`);
        expect((await call(meRoutes.get, undefined, { context: signedIn(`qa@team.example`, lists) }))?.internal).toBe(true);
        expect((await call(meRoutes.get, undefined, { context: signedIn(`someone@else.example`, lists) }))?.internal).toBe(false);
    });
});

// A query's columns as Prisma takes them: a column, or a relation with columns of its own.
type Select = { readonly [column: string]: true | { readonly select?: Select } };

describe(`me.export`, () => {
    // Every query the export makes, by table, answered empty: what is asked for, and keyed to whom, is the assertion.
    const recording = () => {
        const calls: { table: string; where: unknown; select: Select | undefined }[] = [];
        const delegate = (table: string) =>
            new Proxy(
                {},
                {
                    get: (_delegate, method: string) => async (args: { where?: unknown; select?: Select }) => {
                        calls.push({ table, where: args.where, select: args.select });
                        return method === `findUnique` ? null : [];
                    },
                },
            );
        return { calls, prisma: stand<PrismaClient>(new Proxy({}, { get: (_prisma, table: string) => delegate(table) })) };
    };
    const selected = (select: Select | undefined): string[] =>
        Object.entries(select ?? {}).flatMap(([name, value]) => [name, ...(value === true ? [] : selected(value.select))]);

    it(`answers every section, each read by the caller's id or their address as stored, lowercased`, async () => {
        const { calls, prisma } = recording();
        const context = stand<OrpcContext>({ prisma, user: { id: `user-1`, email: `One@X.test`, name: `One`, image: null, emailVerified: true } });
        const answer = await call(meRoutes.export, undefined, { context });
        expect(Object.keys(answer).toSorted()).toEqual(
            [
                `user`,
                `terms`,
                `hostedSuspended`,
                `preferences`,
                `sessions`,
                `accounts`,
                `sandboxes`,
                `memberships`,
                `invitesSent`,
                `organisations`,
                `hostedPlan`,
                `hostedUsage`,
                `hostedProvisions`,
                `hostedStrikes`,
                `builds`,
                `migrations`,
                `outOfMemory`,
                `trash`,
                `trialUsage`,
                `repairUsage`,
                `apiTokens`,
                `wallets`,
                `walletPayments`,
                `pushDevices`,
                `projectClaims`,
            ].toSorted(),
        );
        expect(answer[`terms`]).toEqual({ acceptedAt: null, version: null });
        const keyedTo = new Set([`{"id":"user-1"}`, `{"userId":"user-1"}`, `{"ownerId":"user-1"}`, `{"email":"one@x.test"}`]);
        const ownedThrough = new Set([`{"sandbox":{"ownerId":"user-1"}}`, `{"machine":{"sandbox":{"ownerId":"user-1"}}}`]);
        expect(calls.filter((made) => !keyedTo.has(JSON.stringify(made.where)) && !ownedThrough.has(JSON.stringify(made.where)))).toEqual([]);
        // One query per section read from the database, and one for the account row the terms and standing come from.
        expect(calls).toHaveLength(22);
    });

    it(`selects no credential: no token, digest, code, payload or secret of any kind`, async () => {
        const { calls, prisma } = recording();
        const context = stand<OrpcContext>({ prisma, user: { id: `user-1`, email: `one@x.test`, name: `One`, image: null, emailVerified: true } });
        await call(meRoutes.export, undefined, { context });
        const columns = new Set(calls.flatMap((made) => selected(made.select)));
        const credentials = [
            `token`,
            `tokenDigest`,
            `setupCode`,
            `fixCode`,
            `setupPayload`,
            `hash`,
            `secretHash`,
            `inviteToken`,
            `accessToken`,
            `refreshToken`,
            `idToken`,
            `password`,
        ];
        expect(credentials.filter((column) => columns.has(column))).toEqual([]);
        // Every query names its columns: a missing select would read the whole row, credentials included.
        expect(calls.filter((made) => made.select === undefined)).toEqual([]);
    });
});
