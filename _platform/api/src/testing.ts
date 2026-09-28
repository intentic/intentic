import { generateKeyPairSync } from "node:crypto";
import type { Prisma } from "@intentic/prisma";
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
// What `curl -sf` answers when nothing listens, or the front says 503.
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
