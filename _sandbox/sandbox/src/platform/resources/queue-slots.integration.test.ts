import { type ChildProcess, spawn } from "node:child_process";
import { mkdtemp, readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageRoot } from "@intentic/constants/node";
import { test, expect } from "bun:test";
import { heldSlots, queueSnapshot } from "./queue-slots.js";

/* The half the unit tests cannot reach: a real flock taken by bin/queue-run, found through st_dev and the inode.
   A wrong base or a wrong device split parses perfectly and matches nothing, so only a live lock proves the chain. */

const QUEUE_RUN = join(packageRoot(import.meta.url), "bin", "queue-run");
const RENDEZVOUS_MS = 30_000;
const POLL_MS = 50;

const dir = async (): Promise<string> => mkdtemp(join(tmpdir(), "queue-slots-"));

// Blocks until the command has actually taken the slot, not until spawn returns, so the read below is never racing
// the fork. A bound that expires throws rather than quietly testing an empty pool.
const holdSlot = async (queue: string, pool: string, seconds: number): Promise<ChildProcess> => {
    const marker = join(queue, `held-${pool}`);
    const child = spawn("bash", [QUEUE_RUN, "--pool", pool, "--limit", "2", "--", "bash", "-c", `echo held > ${marker}; sleep ${seconds}`], {
        env: { ...process.env, INTENTIC_QUEUE_DIR: queue },
    });
    const deadline = Date.now() + RENDEZVOUS_MS;
    while (Date.now() < deadline) {
        try {
            await readFile(marker, "utf8");
            return child;
        } catch {
            await new Promise((resolve) => setTimeout(resolve, POLL_MS));
        }
    }
    child.kill("SIGKILL");
    throw new Error("the holder never took its slot, so nothing below is testing what it says");
};

test("a slot held by a real command is found, and names the process holding it", async () => {
    const queue = await dir();
    const child = await holdSlot(queue, "p", 30);
    try {
        const slots = await heldSlots(queue);
        expect(slots).toHaveLength(1);
        expect(slots[0]?.pool).toBe("p");
        // queue-run execs the command, so the pid holding the lock is the one that was spawned.
        expect(slots[0]?.pid).toBe(child.pid);
        expect(slots[0]?.holderAgeSeconds).toBeGreaterThanOrEqual(0);
    } finally {
        child.kill("SIGKILL");
    }
});

test("releasing the slot makes it stop being held, which is the signal the whole thing rests on", async () => {
    const queue = await dir();
    const child = await holdSlot(queue, "p", 30);
    expect(await heldSlots(queue)).toHaveLength(1);
    child.kill("SIGKILL");
    await new Promise((resolve) => child.on("close", resolve));
    expect(await heldSlots(queue)).toEqual([]);
});

test("pools are summarised separately, and a slot file outlives the hold that created it", async () => {
    const queue = await dir();
    const first = await holdSlot(queue, "busy", 30);
    const second = await holdSlot(queue, "quiet", 30);
    second.kill("SIGKILL");
    await new Promise((resolve) => second.on("close", resolve));
    try {
        const summary = await queueSnapshot(queue);
        expect(summary["busy"]).toMatchObject({ held: 1 });
        // The file remains once written; only the lock went. A pool that reads 0 held is measured, not missing.
        expect(summary["quiet"]).toEqual({ slots: 1, held: 0, longestHoldSeconds: 0 });
    } finally {
        first.kill("SIGKILL");
    }
});

test("a queue directory that was never used is not an error", async () => {
    expect(await heldSlots(join(await dir(), "never-ran"))).toEqual([]);
    expect(await queueSnapshot(join(await dir(), "never-ran"))).toEqual({});
});
