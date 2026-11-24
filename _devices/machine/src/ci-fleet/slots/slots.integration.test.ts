import { join } from "node:path";
import { repoRoot } from "@intentic/constants/node";
import { tempDir, testConfig, testContext } from "../ci-fleet-testing.js";
import { type FleetSys, machineSys } from "../sys.js";
import { SLOT_BYTES } from "./decide.js";
import { SlotsConfigSchema } from "./slots-config.js";
import { createSlotHolder } from "./slots.js";

/* The holder in CI's own pool, with real flock on a temp folder: what it holds, test-memory-pool.mjs cannot take; what
   it hands back, it can; the gate band stays the gates' whole; a child that dies is replaced; and the CI locks it
   reports are the ones a job really holds, read without taking a lock. */

interface Held {
    readonly slots: number;
    readonly release: () => void;
}
// A pool as poolOf reads it from a job's environment.
interface Pool {
    readonly dir: string;
    readonly total: number;
    readonly reserved: number;
    readonly gate: boolean;
}
interface PoolModule {
    readonly poolOf: (env: Record<string, string>) => Pool | undefined;
    readonly acquireSlots: (pool: Pool | undefined, want: number) => Promise<Held>;
}

// The pool as CI's own jobs use it, loaded from the repository's script itself.
const poolScript = join(repoRoot(import.meta.url), "_tools/scripts/lib/test-memory-pool.mjs");
const loadPool = async (): Promise<PoolModule> => {
    const loaded: PoolModule = await import(poolScript);
    return loaded;
};

// The real computer, but Docker says the sandboxes use `gib` GiB.
const sysWithSandboxes = (gib: { value: number }): FleetSys => ({
    ...machineSys,
    run: async (command, args, options) => {
        if (command !== "docker") {
            return await machineSys.run(command, args, options);
        }
        return await Promise.resolve(args[0] === "ps" ? { status: 0, stdout: "abc sandbox\n", stderr: "" } : { status: 0, stdout: `abc ${gib.value * SLOT_BYTES}B / 64GiB\n`, stderr: "" });
    },
});

const setUp = async (gib: { value: number }) => {
    const dir = tempDir("ci-slots-real-");
    const { context } = await testContext(sysWithSandboxes(gib), testConfig({ slots: SlotsConfigSchema.parse({ dir, total: 16, reserved: 6 }) }));
    const pool = await loadPool();
    const env = { TEST_SLOTS_DIR: dir, TEST_SLOTS: "16", TEST_SLOTS_RESERVED: "6" };
    return { dir, context, pool, open: pool.poolOf(env), gate: pool.poolOf({ ...env, TEST_SLOTS_PRIORITY: "gate" }), holder: createSlotHolder(context) };
};

test("what the holder holds a job cannot take, and what it hands back the job can", async () => {
    const gib = { value: 4 };
    const { pool, open, holder, context } = await setUp(gib);
    try {
        await holder.look();
        expect(holder.held()).toEqual([16, 15, 14, 13]);
        // Slots 7..12 are left to open runs: six, of which a run takes three quarters.
        const job = await pool.acquireSlots(open, 100);
        expect(job.slots).toBe(5);
        await holder.look();
        expect(context.status.read().slots).toMatchObject({ heldForSandboxes: 4, heldByCi: 5, free: 7 });
        job.release();
        gib.value = 0;
        await holder.stop();
        const after = await pool.acquireSlots(open, 100);
        // All ten above the gate band are free again: three quarters of them, rounded up.
        expect(after.slots).toBe(8);
        after.release();
    } finally {
        await holder.stop();
    }
});

test("the gate band is never taken, however much the sandboxes use", async () => {
    const { pool, open, gate, holder } = await setUp({ value: 64 });
    try {
        await holder.look();
        expect(holder.held()).toEqual([16, 15, 14, 13, 12, 11, 10, 9, 8, 7]);
        expect((await pool.acquireSlots(open, 100)).slots).toBe(0);
        // A gate run tries 1..16 and finds the six of its band free: three quarters of them, rounded up.
        const gated = await pool.acquireSlots(gate, 100);
        expect(gated.slots).toBe(5);
        gated.release();
    } finally {
        await holder.stop();
    }
});

test("a slot a job holds is skipped, then taken when the job lets go", async () => {
    const gib = { value: 0 };
    const { pool, open, holder } = await setUp(gib);
    try {
        // 10 free above the band, a run takes 8: slots 7..14, leaving 15 and 16.
        const job = await pool.acquireSlots(open, 100);
        expect(job.slots).toBe(8);
        gib.value = 4;
        await holder.look();
        expect(holder.held()).toEqual([16, 15]);
        job.release();
        await new Promise((resolve) => setTimeout(resolve, 200));
        await holder.look();
        expect(holder.held()).toEqual([16, 15, 14, 13]);
    } finally {
        await holder.stop();
    }
});

test("a holder child that is killed loses its lock, and the next look takes the slot again", async () => {
    const { holder } = await setUp({ value: 1 });
    try {
        await holder.look();
        const pid = holder.pidOf(16);
        expect(pid).toEqual(expect.any(Number));
        process.kill(pid ?? 0, "SIGKILL");
        await new Promise((resolve) => setTimeout(resolve, 200));
        await holder.look();
        expect(holder.held()).toEqual([16]);
        expect(holder.pidOf(16)).not.toBe(pid);
    } finally {
        await holder.stop();
    }
});
