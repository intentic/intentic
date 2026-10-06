import { generateKeyPairSync } from "node:crypto";
import type { Prisma, PrismaClient } from "@intentic/prisma";
import { CLEAR_STATE_PLAN, type FakeFlyExecAnswer, type FakeFlyMachine } from "@intentic/testing/fly-fake";
import { DAEMON_HEALTH_COMMAND } from "./sandbox/hosted/gate/daemon-health.js";
import type { HostedGateRecord } from "./sandbox/hosted/gate/gate-row.js";
import type { withHostedAppLock } from "./sandbox/hosted/hosted-app-lock.js";

const hostedAppLocks = new Map<string, Promise<void>>();

export const fakeHostedAppLock: typeof withHostedAppLock = async (_config, appName, wait, work) => {
    const held = hostedAppLocks.get(appName);
    if (held && !wait) {
        return undefined;
    }
    const done = Promise.withResolvers<void>();
    const queued = (held ?? Promise.resolve()).then(() => done.promise);
    hostedAppLocks.set(appName, queued);
    await held;
    try {
        return await work();
    } finally {
        done.resolve();
        if (hostedAppLocks.get(appName) === queued) {
            hostedAppLocks.delete(appName);
        }
    }
};

// Shared fixtures for the platform api's suites, one per seam. The ingress keypair is real, not faked: a grant is
// Ed25519 over a canonical payload, so tests sign and verify with it directly, with nothing to stub. Generated once per
// process rather than a literal PEM, which would be a secret shape checked into the repo.
const { privateKey, publicKey } = generateKeyPairSync("ed25519");

export const INGRESS_TEST_PRIVATE_KEY = privateKey.export({ type: "pkcs8", format: "pem" }).toString();
export const INGRESS_TEST_PUBLIC_KEY = publicKey.export({ type: "spki", format: "pem" }).toString();

// Ingress config for a reachable-sandboxes platform; `sbx.test` keeps hostnames in a zone nobody real owns.
export const testIngressConfig = {
    zone: `sbx.test`,
    url: `https://ingress.sbx.test`,
    signingKey: INGRESS_TEST_PRIVATE_KEY,
};

/* A SANDBOX WHOSE DAEMON CHECKS IN AFTER EVERY START: each read of its row answers a later `lastSeenAt` than the one
 * before, so the state gate's wait for a check-in (sandbox/hosted/gate/gate-row.ts) is met at its first look. `row` is
 * what else the read answers, for a suite whose other reads of the sandbox row need their own fields. */
export const checkingIn = (row: { readonly tokenDigest?: string } = {}) => {
    let checkIns = 0;
    return jest.fn(async () => {
        checkIns += 1;
        return { ...row, lastSeenAt: new Date(checkIns * 60_000) };
    });
};

// The machine row's columns the state gate reads and writes.
export interface FakeGateRow {
    image: string | null;
    environmentHash: string | null;
    baseImage: string | null;
    baseDigest: string | null;
    previousImage: string | null;
    previousEnvironmentHash: string | null;
    unprovenImage: string | null;
    skippedDigest: string | null;
}

/* THE ROWS THE STATE GATE READS AND WRITES, in memory: `row` starts as given and takes every update, which `updates`
 * lists in order; the sandbox checks in after every start unless `checksIn` is false (a daemon that never announces). */
export const fakeGateRecord = (row: Partial<FakeGateRow> = {}, checksIn = true) => {
    const held: FakeGateRow = {
        image: null,
        environmentHash: null,
        baseImage: null,
        baseDigest: null,
        previousImage: null,
        previousEnvironmentHash: null,
        unprovenImage: null,
        skippedDigest: null,
        ...row,
    };
    const updates: Prisma.HostedMachineUpdateInput[] = [];
    const prisma = {
        hostedMachine: {
            findUnique: jest.fn(async () => ({ ...held })),
            update: jest.fn(async ({ data }: { data: Prisma.HostedMachineUpdateInput }) => {
                updates.push(data);
                Object.assign(held, data);
                return held;
            }),
        },
        sandbox: { findUnique: checksIn ? checkingIn() : jest.fn(async () => ({ lastSeenAt: null })) },
        // Where a wake says why a rebuild on trial was not kept (hosted.ts).
        hostedBuild: { updateMany: jest.fn(async () => ({ count: 1 })) },
    };
    // SAFETY: the gate reads and writes only these methods (gate-row.ts, state-gate.ts's stranding stamp, hosted.ts's wake).
    const record: HostedGateRecord = { prisma: prisma as never, hostedMachineId: `h1`, sandboxId: `s1` };
    return { record, row: held, updates, prisma };
};

// A `/health` body as a daemon answers it, as much of it as the gate reads.
export interface FakeHealthBody {
    readonly ready?: boolean;
    readonly boot?: { readonly ready: boolean };
    readonly state?: { readonly journal: string };
}
export const healthAnswer = (body: FakeHealthBody): FakeFlyExecAnswer => ({ exit_code: 0, stdout: `${JSON.stringify(body)}\n`, stderr: `` });
// What `curl -sf` answers when nothing listens, or netd says 503.
export const NO_HEALTH: FakeFlyExecAnswer = { exit_code: 7, stdout: ``, stderr: `curl: (7) Failed to connect to localhost port 8787` };
const CLEAR_PLAN: FakeFlyExecAnswer = { exit_code: 0, stdout: `${JSON.stringify(CLEAR_STATE_PLAN)}\n`, stderr: `` };
// How many times each machine's `/health` was asked; per machine, since a suite's fake holds one object for a test's life.
const healthAsks = new WeakMap<FakeFlyMachine, number>();

/* WHAT A HOSTED MACHINE ANSWERS THE COMMANDS THE PLATFORM RUNS IN IT (Fly's exec, the shared fake's `commands.answer`):
 * the state planner, clear unless `plan` says otherwise, and the daemon's `/health`, ready with its journal committed
 * unless `health` says otherwise. `health` gets how many times it was asked before, and the machine, so a test can play a
 * boot that converges, or one that exits under it. */
export const machineAnswers =
    (options: { readonly plan?: () => FakeFlyExecAnswer; readonly health?: (asked: number, machine: FakeFlyMachine) => FakeFlyExecAnswer }) =>
    (machine: FakeFlyMachine, command: readonly string[]): FakeFlyExecAnswer => {
        if (command.join(` `) !== DAEMON_HEALTH_COMMAND.join(` `)) {
            return (options.plan ?? (() => CLEAR_PLAN))();
        }
        const asked = healthAsks.get(machine) ?? 0;
        healthAsks.set(machine, asked + 1);
        return (options.health ?? (() => healthAnswer({ boot: { ready: true }, state: { journal: `none` } })))(asked, machine);
    };

/* AN ACCOUNT'S ROWS, HELD IN MEMORY, for the erase path (account-erase.ts) and every read of hosted standing: the user
 * and its Google account, sandboxes with their machines, trash, provisions, the cleanup queue, the plan and the Stripe
 * queue, strikes, usage and carried standing records. Each delegate answers the `where` shapes the platform writes
 * (equality, null, `in`, `not: null`, `lt`, `lte`, `gte`, and a machine's `sandbox: { ownerId }`), returns whole rows
 * whatever the `select`, and cascades a user's or sandbox's delete the way the schema does. `locked` records every
 * sandbox row lock taken, in order. */
type Scalar = string | number | boolean | Date | null;

interface Operators {
    readonly in?: readonly Scalar[];
    readonly not?: null;
    readonly lt?: Scalar;
    readonly lte?: Scalar;
    readonly gte?: Scalar;
}

type Condition = Scalar | Operators;
type Where = Readonly<Partial<Record<string, Condition>>>;
type FakeRow = Readonly<Partial<Record<string, Scalar | readonly FakePlanItem[]>>>;

interface FakePlanItem {
    readonly tier: string;
    readonly quantity: number;
}

// A type rather than an interface, so a row reads as the column map the `where` matcher indexes.
type FakeUser = {
    id: string;
    email: string;
    createdAt: Date;
    hostedSuspendedAt: Date | null;
    hostedSuspendedReason: string | null;
};

interface FakeGoogleAccount {
    readonly accountId: string;
}

export type FakeAccountRows = {
    users: FakeUser[];
    accounts: { userId: string; providerId: string; accountId: string }[];
    sandboxes: { id: string; ownerId: string }[];
    machines: { sandboxId: string; appName: string; tier: string; wokeAt: Date | null; createdAt: Date }[];
    trash: { id: string; ownerId: string; appName: string | null }[];
    provisions: { userId: string; appName: string }[];
    cleanup: { appName: string; deleteAfter: Date }[];
    plans: { userId: string; stripeCustomerId: string; stripeSubscriptionId: string; status: string; items: FakePlanItem[] }[];
    erasures: { customerId: string; subscriptionId: string | null }[];
    strikes: { userId: string; action: string; createdAt: Date }[];
    usage: { ownerId: string; sandboxId: string | null; month: string; tier: string; minutes: number }[];
    standing: {
        subjectHash: string;
        suspendedAt: Date | null;
        strikes: number;
        standingAt: Date | null;
        month: string | null;
        freeMinutes: number;
    }[];
};

// Dates by instant, everything else as text: the months (`YYYY-MM`) and ids the platform compares sort that way.
const order = (left: Scalar | readonly FakePlanItem[] | undefined, right: Scalar): number =>
    left instanceof Date && right instanceof Date ? left.getTime() - right.getTime() : String(left).localeCompare(String(right));

const operatorsMatch = (value: Scalar | readonly FakePlanItem[] | undefined, { in: among, not, lt, lte, gte }: Operators): boolean => {
    const present = value !== null && value !== undefined;
    return (
        (among === undefined || among.some((candidate) => candidate === value)) &&
        (not === undefined || present) &&
        (lt === undefined || (present && order(value, lt) < 0)) &&
        (lte === undefined || (present && order(value, lte) <= 0)) &&
        (gte === undefined || (present && order(value, gte) >= 0))
    );
};

const fieldMatches = (value: Scalar | readonly FakePlanItem[] | undefined, condition: Condition | undefined): boolean => {
    if (condition === undefined) {
        return true;
    }
    if (condition === null) {
        return value === null || value === undefined;
    }
    if (condition instanceof Date) {
        return value instanceof Date && value.getTime() === condition.getTime();
    }
    return condition instanceof Object ? operatorsMatch(value, condition) : value === condition;
};

const rowMatches = (row: FakeRow, where: Where | undefined): boolean =>
    Object.entries(where ?? {}).every(([column, condition]) => fieldMatches(row[column], condition));

// Removes every row a `where` matches, in place, so every delegate over the same array sees the delete.
const dropWhere = <Row extends FakeRow>(rows: Row[], where: Where | undefined): number => {
    const doomed = rows.filter((row) => rowMatches(row, where));
    for (const row of doomed) {
        rows.splice(rows.indexOf(row), 1);
    }
    return doomed.length;
};

// One table's delegate over an array the fixture owns; `key` names the unique column upserts and findUnique address.
const table = <Row extends FakeRow>(rows: Row[], key: keyof Row & string, fill: (create: Partial<Row>) => Row) => ({
    findUnique: jest.fn(async ({ where }: { where: Where }) => rows.find((row) => row[key] === where[key]) ?? null),
    findFirst: jest.fn(async ({ where }: { where?: Where } = {}) => rows.find((row) => rowMatches(row, where)) ?? null),
    findMany: jest.fn(async ({ where }: { where?: Where } = {}) => rows.filter((row) => rowMatches(row, where))),
    count: jest.fn(async ({ where }: { where?: Where } = {}) => rows.filter((row) => rowMatches(row, where)).length),
    upsert: jest.fn(async ({ where, create, update }: { where: Where; create: Partial<Row>; update: Partial<Row> }) => {
        const existing = rows.find((row) => row[key] === where[key]);
        if (existing !== undefined) {
            return Object.assign(existing, update);
        }
        const made = fill(create);
        rows.push(made);
        return made;
    }),
    updateMany: jest.fn(async ({ where, data }: { where?: Where; data: Partial<Row> }) => {
        const hits = rows.filter((row) => rowMatches(row, where));
        for (const row of hits) {
            Object.assign(row, data);
        }
        return { count: hits.length };
    }),
    deleteMany: jest.fn(async ({ where }: { where?: Where } = {}) => ({ count: dropWhere(rows, where) })),
});

// A sandbox's delete takes its machine and nulls its usage rows' sandbox, as the schema's cascade and SetNull do.
const dropSandboxes = (rows: FakeAccountRows, where: Where | undefined): number => {
    const doomed = new Set(rows.sandboxes.filter((sandbox) => rowMatches(sandbox, where)).map((sandbox) => sandbox.id));
    dropWhere(rows.sandboxes, { id: { in: [...doomed] } });
    dropWhere(rows.machines, { sandboxId: { in: [...doomed] } });
    for (const usage of rows.usage) {
        if (usage.sandboxId !== null && doomed.has(usage.sandboxId)) {
            usage.sandboxId = null;
        }
    }
    return doomed.size;
};

// The user's delete, and everything the schema ties to it; the standing and the two queues are tied to nothing.
const dropUser = (rows: FakeAccountRows, id: string): FakeUser => {
    const user = rows.users.find((candidate) => candidate.id === id);
    if (user === undefined) {
        throw new Error(`no user ${id}`);
    }
    dropWhere(rows.users, { id });
    dropSandboxes(rows, { ownerId: id });
    dropWhere(rows.accounts, { userId: id });
    dropWhere(rows.trash, { ownerId: id });
    dropWhere(rows.provisions, { userId: id });
    dropWhere(rows.plans, { userId: id });
    dropWhere(rows.strikes, { userId: id });
    dropWhere(rows.usage, { ownerId: id });
    return user;
};

// The user row, with its Google accounts beside it when the read selected them (GOOGLE_SUBJECT_SELECT).
const userRead = (rows: FakeAccountRows, user: FakeUser | undefined, select?: { readonly accounts?: object }): (FakeUser & { accounts?: FakeGoogleAccount[] }) | null => {
    if (user === undefined) {
        return null;
    }
    if (select?.accounts === undefined) {
        return user;
    }
    return { ...user, accounts: rows.accounts.filter((account) => account.userId === user.id && account.providerId === `google`) };
};

const userDelegate = (rows: FakeAccountRows) => ({
    findUnique: jest.fn(async ({ where, select }: { where: { id: string }; select?: { accounts?: object } }) =>
        userRead(rows, rows.users.find((user) => user.id === where.id), select),
    ),
    update: jest.fn(async ({ where, data, select }: { where: { id: string }; data: Partial<FakeUser>; select?: { accounts?: object } }) => {
        const user = rows.users.find((candidate) => candidate.id === where.id);
        if (user === undefined) {
            throw new Error(`no user ${where.id}`);
        }
        return userRead(rows, Object.assign(user, data), select);
    }),
    delete: jest.fn(async ({ where }: { where: { id: string } }) => dropUser(rows, where.id)),
});

// The meter's one grouping of usage rows, by sandbox and tier.
const usageGroups = (rows: FakeAccountRows, where: Where | undefined) => {
    const groups = new Map<string, { sandboxId: string | null; tier: string; _sum: { minutes: number } }>();
    for (const usage of rows.usage.filter((row) => rowMatches(row, where))) {
        const group = groups.get(`${usage.sandboxId}/${usage.tier}`) ?? { sandboxId: usage.sandboxId, tier: usage.tier, _sum: { minutes: 0 } };
        group._sum.minutes += usage.minutes;
        groups.set(`${usage.sandboxId}/${usage.tier}`, group);
    }
    return [...groups.values()];
};

// A machine read by its sandbox's owner, the one relation filter the erase and the meter use.
const machineDelegate = (rows: FakeAccountRows) => ({
    findMany: jest.fn(async ({ where }: { where?: { readonly sandbox?: { readonly ownerId: string } } } = {}) =>
        rows.machines.filter((machine) => where?.sandbox === undefined || rows.sandboxes.some((sandbox) => sandbox.id === machine.sandboxId && sandbox.ownerId === where.sandbox?.ownerId)),
    ),
});

const EMPTY_ROWS = (): FakeAccountRows => ({
    users: [],
    accounts: [],
    sandboxes: [],
    machines: [],
    trash: [],
    provisions: [],
    cleanup: [],
    plans: [],
    erasures: [],
    strikes: [],
    usage: [],
    standing: [],
});

export const fakeAccountStore = (seed: Partial<FakeAccountRows> = {}) => {
    const rows: FakeAccountRows = { ...EMPTY_ROWS(), ...seed };
    const locked: string[] = [];
    const delegates = {
        $queryRaw: jest.fn(async (_sql: TemplateStringsArray, id: string) => {
            locked.push(id);
            return [];
        }),
        user: userDelegate(rows),
        account: table(rows.accounts, `accountId`, (create) => ({ userId: ``, providerId: ``, accountId: ``, ...create })),
        sandbox: {
            findMany: jest.fn(async ({ where }: { where?: Where } = {}) => rows.sandboxes.filter((sandbox) => rowMatches(sandbox, where))),
            deleteMany: jest.fn(async ({ where }: { where?: Where } = {}) => ({ count: dropSandboxes(rows, where) })),
        },
        hostedMachine: machineDelegate(rows),
        sandboxTrash: table(rows.trash, `id`, (create) => ({ id: ``, ownerId: ``, appName: null, ...create })),
        hostedProvision: table(rows.provisions, `appName`, (create) => ({ userId: ``, appName: ``, ...create })),
        hostedCleanup: table(rows.cleanup, `appName`, (create) => ({ appName: ``, deleteAfter: new Date(0), ...create })),
        hostedPoolMachine: { deleteMany: jest.fn(async () => ({ count: 0 })) },
        hostedPlan: table(rows.plans, `userId`, (create) => ({ userId: ``, stripeCustomerId: ``, stripeSubscriptionId: ``, status: ``, items: [], ...create })),
        stripeErasure: table(rows.erasures, `customerId`, (create) => ({ customerId: ``, subscriptionId: null, ...create })),
        hostedStrike: table(rows.strikes, `createdAt`, (create) => ({ userId: ``, action: ``, createdAt: new Date(0), ...create })),
        hostedUsage: {
            ...table(rows.usage, `sandboxId`, (create) => ({ ownerId: ``, sandboxId: null, month: ``, tier: ``, minutes: 0, ...create })),
            groupBy: jest.fn(async ({ where }: { where?: Where }) => usageGroups(rows, where)),
        },
        hostedStanding: table(rows.standing, `subjectHash`, (create) => ({
            subjectHash: ``,
            suspendedAt: null,
            strikes: 0,
            standingAt: null,
            month: null,
            freeMinutes: 0,
            ...create,
        })),
    };
    // One transaction is the same store: the erase's work runs against it directly, and a throw leaves what it wrote.
    const db = { ...delegates, $transaction: jest.fn(async <T>(work: (tx: typeof delegates) => Promise<T>): Promise<T> => work(delegates)) };
    // SAFETY: every delegate the erase path, the standing reads and the sweeps call is present above (a missing one
    // fails the test naming the call), and each answers in the shape Prisma would for the fields they read.
    const prisma: PrismaClient = db as never;
    return { db, prisma, rows, locked };
};
