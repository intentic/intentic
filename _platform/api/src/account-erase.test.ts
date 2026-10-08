import { FREE_TIER } from "@intentic/constants";
import { unstubbed } from "@intentic/testing";
import { stubGlobal, unstubAllGlobals } from "@intentic/testing/bun";
import { type FakeFly, installFakeFly } from "@intentic/testing/fly-fake";
import type { Logger } from "pino";
import { deleteUserAccount } from "./admin/admin-actions.js";
import { eraseAccount } from "./account-erase.js";
import { createAuth } from "./auth.js";
import { configSchema } from "./config.js";
import { DAY_MS } from "./durations.js";
import {
    CARRIED_SUSPENSION_REASON,
    carriedStandingOf,
    carriedStrikesSince,
    standingSubjectHash,
    sweepHostedStanding,
} from "./sandbox/hosted/abuse/carried-standing.js";
import { assertHostedStanding, HostedSuspended, hostedSuspensionOf, liftHostedSuspension } from "./sandbox/hosted/abuse/hosted-standing.js";
import { reconcileHostedCleanup } from "./sandbox/hosted/hosted-cleanup.js";
import { StripeError, type StripeGateway } from "./sandbox/hosted/plan/hosted-plan-stripe.js";
import { accountHoursOf } from "./sandbox/hosted/hosted-usage.js";
import { fakeAccountStore, fakeHostedAppLock, testIngressConfig } from "./testing.js";

jest.mock(`./sandbox/hosted/hosted-app-lock.js`, () => ({ withHostedAppLock: fakeHostedAppLock }));

// One erase for both deletions: every hosted app the account owns queued and destroyed, the Stripe customer ended
// with retries that outlive the account, and the hosted standing carried to whoever signs in with the same Google
// account next. Mode: no Postgres; the account's rows are the in-memory store (testing.ts), Fly is the shared
// fly-fake over `fetch`, Stripe is the gateway seam.

const NOW = new Date(`2026-09-15T12:00:00Z`);
const SUSPENDED_AT = new Date(`2026-09-10T08:00:00Z`);

const config = configSchema.parse({
    database: { url: `postgres://test` },
    betterAuth: { secret: `erase-test-secret` },
    secrets: { key: `` },
    webOrigin: `https://app.test`,
    ingress: testIngressConfig,
    // The ramp off: the returning account is minutes old, and these figures are the month's.
    hosted: { flyApiToken: `fly`, flyOrg: `org`, newAccountDays: 0 },
    hostedPlan: { stripeSecretKey: `sk_test`, stripePrices: `` },
});
const FREE_MINUTES = config.hosted.monthlyHours * 60;
// SAFETY: the erase, the sweeps and Better Auth's setup log through these five methods and nothing else.
const logger: Logger = { info: jest.fn(), warn: jest.fn(), error: jest.fn(), debug: jest.fn(), child: () => logger } as never;

// The account being erased owns a live machine, a trashed sandbox still inside its undo window, a released machine
// whose volume is held for a week, and a provision whose app is long gone; a second account's machine stands beside it.
const APPS = { live: `intentic-sbx-live`, trashed: `intentic-sbx-trashed`, released: `intentic-sbx-released`, other: `intentic-sbx-other` };

const seededStore = () =>
    fakeAccountStore({
        users: [
            { id: `u1`, email: `gone@example.test`, createdAt: new Date(`2026-01-01T00:00:00Z`), hostedSuspendedAt: SUSPENDED_AT, hostedSuspendedReason: `mining` },
            { id: `u2`, email: `stays@example.test`, createdAt: new Date(`2026-01-01T00:00:00Z`), hostedSuspendedAt: null, hostedSuspendedReason: null },
        ],
        accounts: [
            { userId: `u1`, providerId: `google`, accountId: `google-subject-a` },
            { userId: `u2`, providerId: `google`, accountId: `google-subject-b` },
        ],
        sandboxes: [
            { id: `s1`, ownerId: `u1` },
            { id: `s2`, ownerId: `u2` },
        ],
        machines: [
            { sandboxId: `s1`, appName: APPS.live, tier: FREE_TIER.id, wokeAt: null, createdAt: new Date(`2026-02-01T00:00:00Z`) },
            { sandboxId: `s2`, appName: APPS.other, tier: FREE_TIER.id, wokeAt: null, createdAt: new Date(`2026-02-01T00:00:00Z`) },
        ],
        trash: [{ id: `t1`, ownerId: `u1`, appName: APPS.trashed }],
        provisions: [
            { userId: `u1`, appName: APPS.released },
            { userId: `u1`, appName: `intentic-sbx-long-gone` },
        ],
        cleanup: [{ appName: APPS.released, deleteAfter: new Date(NOW.getTime() + 7 * DAY_MS) }],
        plans: [{ userId: `u1`, stripeCustomerId: `cus_1`, stripeSubscriptionId: `sub_1`, status: `active`, items: [] }],
        strikes: [
            { userId: `u1`, action: `stopped`, createdAt: new Date(`2026-08-20T00:00:00Z`) },
            { userId: `u1`, action: `suspended`, createdAt: SUSPENDED_AT },
            // A subscriber's machine reported, never stopped: not a strike towards a suspension.
            { userId: `u1`, action: `reported`, createdAt: new Date(`2026-09-12T00:00:00Z`) },
            { userId: `u2`, action: `stopped`, createdAt: new Date(`2026-09-01T00:00:00Z`) },
        ],
        usage: [
            { ownerId: `u1`, sandboxId: `s1`, month: `2026-09`, tier: FREE_TIER.id, minutes: 240 },
            // A released machine's minutes stay on the account's month.
            { ownerId: `u1`, sandboxId: null, month: `2026-09`, tier: FREE_TIER.id, minutes: 60 },
            // Last month's: nothing to carry.
            { ownerId: `u1`, sandboxId: `s1`, month: `2026-08`, tier: FREE_TIER.id, minutes: 900 },
        ],
    });

// Fly with every app of both accounts standing; `down` answers every call with a 503. What is not Fly goes to
// `passThrough`, which refuses unless a test stands something there.
const flyWith = (down = false, passThrough?: (input: RequestInfo | URL, init?: RequestInit) => Promise<Response>): FakeFly => {
    const refuseOthers = async (input: RequestInfo | URL): Promise<Response> => { throw new Error(`unexpected request to ${String(input)}`); };
    const options = { passThrough: passThrough ?? refuseOthers };
    const fly = installFakeFly((name, value) => stubGlobal(name, value), down ? { ...options, faults: { status: 503 } } : options);
    for (const app of Object.values(APPS)) {
        fly.apps.add(app);
    }
    return fly;
};

// Stripe's two erasure calls, in order; `refuseDelete` makes the customer delete fail as Stripe being down would.
const stripeWith = (refuseDelete = false) => {
    const calls: string[] = [];
    const gateway = unstubbed<StripeGateway>(`stripe`, {
        cancelSubscription: async (id) => {
            calls.push(`cancel ${id}`);
            return { id, customer: `cus_1`, status: `canceled`, currentPeriodEnd: NOW, cancelAtPeriodEnd: false, items: [] };
        },
        deleteCustomer: async (id) => {
            calls.push(`delete ${id}`);
            if (refuseDelete) {
                throw new StripeError(`Stripe refused: unavailable`, 503);
            }
        },
    });
    return { gateway, calls };
};

const CARRIED_A = {
    subjectHash: standingSubjectHash(config, `google-subject-a`),
    suspendedAt: SUSPENDED_AT,
    strikes: 2,
    standingAt: SUSPENDED_AT,
    month: `2026-09`,
    freeMinutes: 300,
};

// What either deletion leaves once Fly and Stripe answered: the account's apps destroyed and unqueued, the other
// account's untouched, the customer deleted, and the standing on the Google subject's record.
const expectErased = (store: ReturnType<typeof seededStore>, fly: FakeFly, stripeCalls: readonly string[]): void => {
    expect([...fly.apps]).toEqual([APPS.other]);
    expect(store.rows.cleanup).toEqual([]);
    expect(stripeCalls).toEqual([`cancel sub_1`, `delete cus_1`]);
    expect(store.rows.erasures).toEqual([]);
    expect(store.rows.standing).toEqual([CARRIED_A]);
    expect(store.rows.users.map((user) => user.id)).toEqual([`u2`]);
    expect(store.rows.sandboxes).toEqual([{ id: `s2`, ownerId: `u2` }]);
    expect(store.rows.trash).toEqual([]);
    expect(store.rows.strikes).toEqual([{ userId: `u2`, action: `stopped`, createdAt: new Date(`2026-09-01T00:00:00Z`) }]);
    expect(store.locked).toEqual([`s1`]);
};

// The clock only: every erase reads the month and the strike window off `new Date()`, and timers stay real.
beforeEach(() => {
    jest.setSystemTime(NOW);
});

afterEach(() => {
    jest.setSystemTime();
    unstubAllGlobals();
});

describe(`erasing an account`, () => {
    it(`on the owner's own deletion (Better Auth's beforeDelete), queues and destroys every hosted app and deletes the Stripe customer`, async () => {
        const store = seededStore();
        // Stripe over HTTP, as the platform's own client speaks it: the hook builds its gateway from config.
        const stripeCalls: string[] = [];
        const fly = flyWith(false, async (input, init) => {
            const call = `${init?.method ?? `GET`} ${new URL(String(input)).pathname}`;
            if (call === `DELETE /v1/subscriptions/sub_1`) {
                stripeCalls.push(`cancel sub_1`);
                return Response.json({ id: `sub_1`, customer: `cus_1`, status: `canceled` });
            }
            if (call === `DELETE /v1/customers/cus_1`) {
                stripeCalls.push(`delete cus_1`);
                return Response.json({ id: `cus_1`, object: `customer`, deleted: true });
            }
            return Response.json({ error: { message: `unexpected ${call}` } }, { status: 400 });
        });
        // The real Better Auth options, so the hook that runs is the one the platform mounts.
        const auth = createAuth({ ...config, hostedPlan: { ...config.hostedPlan, stripeApiUrl: `https://stripe.test/v1` } }, store.prisma, logger);
        const beforeDelete = auth.options.user?.deleteUser?.beforeDelete;
        expect(beforeDelete).toBeInstanceOf(Function);

        await beforeDelete?.({ id: `u1`, email: `gone@example.test`, name: `Gone`, emailVerified: true, createdAt: NOW, updatedAt: NOW });
        // Better Auth deletes the row itself once the hook has returned.
        await store.prisma.user.delete({ where: { id: `u1` } });

        expectErased(store, fly, stripeCalls);
    });

    it(`on an operator's deletion, does exactly the same and says what it erased`, async () => {
        const store = seededStore();
        const fly = flyWith();
        const stripe = stripeWith();

        const result = await deleteUserAccount(store.prisma, config, logger, `u1`, stripe.gateway);

        expect(result).toEqual({ ok: true, message: `gone@example.test erased: sandboxes, grants and the hosted plan are gone with the account.` });
        expectErased(store, fly, stripe.calls);
    });

    it(`keeps every app and the Stripe ids queued when Fly and Stripe are down, runs again without counting twice, and the sweeps finish it`, async () => {
        const store = seededStore();
        flyWith(true);
        const stripe = stripeWith(true);

        const first = await eraseAccount(store.prisma, config, logger, `u1`, { gateway: stripe.gateway, now: NOW });
        expect(first).toEqual({ apps: [APPS.live, APPS.trashed, APPS.released], destroyed: [], stripe: `queued`, carried: true });
        // Due now, the release's week-long hold pulled forward; the long-gone provision is not queued at all.
        expect(store.rows.cleanup).toEqual([
            { appName: APPS.released, deleteAfter: NOW },
            { appName: APPS.live, deleteAfter: NOW },
            { appName: APPS.trashed, deleteAfter: NOW },
        ]);
        expect(store.rows.erasures).toEqual([{ customerId: `cus_1`, subscriptionId: `sub_1` }]);
        expect(store.rows.standing).toEqual([CARRIED_A]);

        // The user row survived the failure (say the delete after it never ran): a second erase changes nothing.
        const again = await eraseAccount(store.prisma, config, logger, `u1`, { gateway: stripe.gateway, now: NOW });
        expect(again).toEqual({ apps: [APPS.released], destroyed: [], stripe: `queued`, carried: true });
        expect(store.rows.standing).toEqual([CARRIED_A]);
        expect(store.rows.cleanup.map((row) => row.appName).toSorted()).toEqual([APPS.live, APPS.released, APPS.trashed]);
        await store.prisma.user.delete({ where: { id: `u1` } });
        // The queues are tied to no user, so the cascade leaves them.
        expect(store.rows.erasures).toEqual([{ customerId: `cus_1`, subscriptionId: `sub_1` }]);
        expect(store.rows.cleanup).toHaveLength(3);

        const fly = flyWith();
        await reconcileHostedCleanup(store.prisma, config, logger);
        expect([...fly.apps]).toEqual([APPS.other]);
        expect(store.rows.cleanup).toEqual([]);
    });

    it(`carries nothing for an account with no Google sign-in, and lets its standing go with the cascade`, async () => {
        const store = seededStore();
        store.rows.accounts.splice(0, 1);
        flyWith();
        const result = await eraseAccount(store.prisma, config, logger, `u1`, { gateway: stripeWith().gateway, now: NOW });
        expect(result.carried).toBe(false);
        expect(store.rows.standing).toEqual([]);
    });
});

describe(`signing in again after an erase`, () => {
    // The erased account comes back as u3 with the same Google subject; u4 is somebody else.
    const returned = async () => {
        const store = seededStore();
        flyWith();
        await deleteUserAccount(store.prisma, config, logger, `u1`, stripeWith().gateway);
        store.rows.users.push(
            { id: `u3`, email: `back@example.test`, createdAt: NOW, hostedSuspendedAt: null, hostedSuspendedReason: null },
            { id: `u4`, email: `new@example.test`, createdAt: NOW, hostedSuspendedAt: null, hostedSuspendedReason: null },
        );
        store.rows.accounts.push(
            { userId: `u3`, providerId: `google`, accountId: `google-subject-a` },
            { userId: `u4`, providerId: `google`, accountId: `google-subject-c` },
        );
        return store;
    };

    it(`finds the same Google subject still suspended, with its strikes and this month's free minutes`, async () => {
        const store = await returned();
        expect(await hostedSuspensionOf(store.prisma, config, `u3`)).toEqual({ at: SUSPENDED_AT, reason: CARRIED_SUSPENSION_REASON });
        await expect(assertHostedStanding(store.prisma, config, `u3`)).rejects.toBeInstanceOf(HostedSuspended);
        const free = (await accountHoursOf(store.prisma, config, `u3`, NOW)).free;
        expect(free).toEqual({
            kind: `free`,
            tier: FREE_TIER.id,
            metered: true,
            allowanceMinutes: FREE_MINUTES,
            remainingMinutes: FREE_MINUTES - 300,
            usedMinutes: 300,
        });
        const carried = await carriedStandingOf(store.prisma, config, [{ accountId: `google-subject-a` }]);
        // Counted towards the watch's next verdict while the latest of them is inside its window, and not after.
        expect(carriedStrikesSince(carried, new Date(NOW.getTime() - config.hosted.abuseStrikeDays * DAY_MS))).toBe(2);
        expect(carriedStrikesSince(carried, new Date(`2026-09-11T00:00:00Z`))).toBe(0);
    });

    it(`leaves a different Google subject in good standing with a fresh month`, async () => {
        const store = await returned();
        expect(await hostedSuspensionOf(store.prisma, config, `u4`)).toBeUndefined();
        expect((await accountHoursOf(store.prisma, config, `u4`, NOW)).free.usedMinutes).toBe(0);
        expect(carriedStrikesSince(await carriedStandingOf(store.prisma, config, [{ accountId: `google-subject-c` }]), new Date(0))).toBe(0);
        // Nor does next month carry anything for the returning subject: the minutes were September's.
        expect((await accountHoursOf(store.prisma, config, `u3`, new Date(`2026-10-02T00:00:00Z`))).free.usedMinutes).toBe(0);
    });

    it(`lets an operator lift a carried suspension, which keeps the strikes`, async () => {
        const store = await returned();
        await liftHostedSuspension(store.prisma, config, logger, `u3`);
        expect(await hostedSuspensionOf(store.prisma, config, `u3`)).toBeUndefined();
        expect(store.rows.standing).toEqual([{ ...CARRIED_A, suspendedAt: null }]);
    });

    it(`hashes the subject under a key derived from the platform's secret, so another secret names nobody`, () => {
        expect(standingSubjectHash(config, `google-subject-a`)).toMatch(/^[0-9a-f]{64}$/u);
        expect(standingSubjectHash(config, `google-subject-a`)).toBe(CARRIED_A.subjectHash);
        expect(standingSubjectHash({ betterAuth: { secret: `another-secret` } }, `google-subject-a`)).not.toBe(CARRIED_A.subjectHash);
    });
});

describe(`the retention of carried standing`, () => {
    it(`clears a standing twelve months after its latest change, minutes once their month ends, and drops a record with nothing left`, async () => {
        const expired = new Date(NOW.getTime() - 366 * DAY_MS);
        const recent = new Date(NOW.getTime() - 10 * DAY_MS);
        const store = fakeAccountStore({
            standing: [
                { subjectHash: `old-standing-old-minutes`, suspendedAt: expired, strikes: 1, standingAt: expired, month: `2026-08`, freeMinutes: 30 },
                { subjectHash: `old-standing-this-month`, suspendedAt: null, strikes: 3, standingAt: expired, month: `2026-09`, freeMinutes: 50 },
                { subjectHash: `recent-standing-old-minutes`, suspendedAt: recent, strikes: 2, standingAt: recent, month: `2026-08`, freeMinutes: 70 },
                { subjectHash: `recent-standing-no-minutes`, suspendedAt: null, strikes: 1, standingAt: recent, month: null, freeMinutes: 0 },
            ],
        });
        expect(await sweepHostedStanding(store.prisma, NOW)).toEqual({ standingCleared: 2, minutesCleared: 2, standingDropped: 1 });
        expect(store.rows.standing).toEqual([
            { subjectHash: `old-standing-this-month`, suspendedAt: null, strikes: 0, standingAt: null, month: `2026-09`, freeMinutes: 50 },
            { subjectHash: `recent-standing-old-minutes`, suspendedAt: recent, strikes: 2, standingAt: recent, month: null, freeMinutes: 0 },
            { subjectHash: `recent-standing-no-minutes`, suspendedAt: null, strikes: 1, standingAt: recent, month: null, freeMinutes: 0 },
        ]);
    });
});
