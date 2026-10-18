import type { HostedMachine, PrismaClient } from "@intentic/prisma";
import { unstubbed } from "@intentic/testing";
import { sha256Hex } from "@intentic/sandbox-contract/tunnel-ids";
import { configSchema } from "../../../config.js";
import { testIngressConfig } from "../../../testing.js";
import type { HostedWakeSandbox } from "./hosted-wake.js";

export const hostedWakeConfig = () => configSchema.parse({
    database: { url: "postgresql://test@localhost/test" },
    betterAuth: { secret: "wake-test" },
    webOrigin: "https://app.test",
    ingress: testIngressConfig,
    hosted: { flyApiToken: "fly-test", flyOrg: "test", newAccountDays: 0 },
});

export const hostedWakeSandbox = (id = "s1"): HostedWakeSandbox => ({
    id, ownerId: "u1", token: `connect-${id}`, owner: { email: "owner@example.com" },
    hosted: {
        id: `h-${id}`, sandboxId: id, appName: `app-${id}`, machineId: `m-${id}`, volumeId: `vol-${id}`,
        region: "iad", warm: false, tier: "free", cpuKind: "shared", cpus: 2, memoryMb: 4096, volumeGb: 10,
        wokeAt: null, idleWarnedAt: null, image: null, baseImage: null, baseDigest: null, environmentHash: null,
        buildingId: null, migratingId: null, strandedAt: null, strandedDetail: null, previousImage: null,
        previousEnvironmentHash: null, unprovenImage: null, skippedDigest: null, probationSince: null, probationStrikes: 0,
        createdAt: new Date(0), updatedAt: new Date(0),
    } satisfies HostedMachine,
});

export interface WakeAlarmRow extends Omit<HostedWakeSandbox, "hosted"> {
    hosted: HostedMachine | null;
    tokenDigest: string;
    removedAt: Date | null;
    scheduledWakeAt: Date | null;
    scheduledWakeRetryAt: Date | null;
    personSeenAt: Date | null;
}

export const wakeAlarmRow = (at: number | null, id = "s1"): WakeAlarmRow => {
    const sandbox = hostedWakeSandbox(id);
    return {
        ...sandbox,
        tokenDigest: sha256Hex(sandbox.token),
        removedAt: null,
        scheduledWakeAt: at === null ? null : new Date(at),
        scheduledWakeRetryAt: null,
        personSeenAt: null,
    };
};

interface AlarmWhere {
    readonly id?: string;
    readonly tokenDigest?: string;
    readonly removedAt?: null;
    readonly hosted?: { readonly isNot: null };
    readonly scheduledWakeAt?: Date | { readonly lte: Date };
    readonly scheduledWakeRetryAt?: null | { readonly lte: Date };
    readonly OR?: readonly AlarmWhere[];
}

const dateMatches = (value: Date | null, asked: Date | { readonly lte: Date } | null | undefined): boolean => {
    if (asked === undefined) { return true; }
    if (asked === null) { return value === null; }
    if (value === null) { return false; }
    return asked instanceof Date ? value.getTime() === asked.getTime() : value.getTime() <= asked.lte.getTime();
};

const alarmMatches = (row: WakeAlarmRow, where: AlarmWhere): boolean =>
    (where.id === undefined || row.id === where.id) &&
    (where.tokenDigest === undefined || row.tokenDigest === where.tokenDigest) &&
    (where.removedAt === undefined || row.removedAt === null) &&
    (where.hosted === undefined || row.hosted !== null) &&
    dateMatches(row.scheduledWakeAt, where.scheduledWakeAt) &&
    dateMatches(row.scheduledWakeRetryAt, where.scheduledWakeRetryAt) &&
    (where.OR === undefined || where.OR.some((branch) => alarmMatches(row, branch)));

// The sweep's order: alarms never tried first, then retries by when they come due, then by deadline (Postgres sorts
// nulls first where the query asks it to).
const sweepOrder = (a: WakeAlarmRow, b: WakeAlarmRow): number => {
    const retry = (row: WakeAlarmRow): number => row.scheduledWakeRetryAt?.getTime() ?? Number.NEGATIVE_INFINITY;
    return retry(a) - retry(b) || (a.scheduledWakeAt?.getTime() ?? 0) - (b.scheduledWakeAt?.getTime() ?? 0);
};

// The alarm's durable table, shared by its ingress and its sweep. Reads return snapshots: a cancellation between the
// read and claim must beat the old snapshot, just as it does in Postgres. Only the query shapes this seam owns are faked.
export const fakeWakeAlarms = (rows: WakeAlarmRow[]) => {
    const table = {
        findMany: jest.fn(async ({ where, take }: { where: AlarmWhere; take: number }) =>
            rows
                .filter((row) => alarmMatches(row, where))
                .toSorted(sweepOrder)
                .slice(0, take)
                .map((row) => ({ ...row })),
        ),
        updateMany: jest.fn(async ({ where, data }: { where: AlarmWhere; data: Partial<Pick<WakeAlarmRow, "scheduledWakeAt" | "scheduledWakeRetryAt" | "personSeenAt">> }) => {
            const matched = rows.filter((row) => alarmMatches(row, where));
            for (const row of matched) { Object.assign(row, data); }
            return { count: matched.length };
        }),
    };
    // SAFETY: the alarm uses only these two sandbox methods, returning the selected row fields above.
    const prisma = unstubbed<PrismaClient>("prisma", { sandbox: table as never });
    return { prisma, table };
};
