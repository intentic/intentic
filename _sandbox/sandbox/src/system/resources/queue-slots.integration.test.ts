import { type ChildProcess, spawn } from "node:child_process";
import { mkdir, mkdtemp, readdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { packageRoot } from "@intentic/constants/node";
import { heldSlots, poolQueueFiles, queueSnapshot } from "./queue-slots.js";

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
        // Named by what it runs, read off the holder itself; whether `bash -c` execs its last command is bash's version.
        expect(slots[0]?.command).toMatch(/^(bash -c echo held > .+; )?sleep 30$/u);
        expect(slots[0]?.cwd).toBe(process.cwd());
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
        expect(summary["quiet"]).toEqual({ slots: 1, held: 0, longestHoldSeconds: 0, waiting: 0, longestWaitSeconds: 0 });
    } finally {
        first.kill("SIGKILL");
    }
});

test("a queue directory that was never used is not an error", async () => {
    expect(await heldSlots(join(await dir(), "never-ran"))).toEqual([]);
    expect(await queueSnapshot(join(await dir(), "never-ran"))).toEqual({});
});

// The question the summary exists for: a command is waiting, so who holds the pool, for whom, and who else waits.
test("a held pool names its holder's conversation and rule, and counts the command waiting behind it", async () => {
    const queue = await dir();
    const marker = join(queue, "held-p");
    const holder = spawn("bash", [QUEUE_RUN, "--pool", "p", "--limit", "1", "--", "bash", "-c", `echo held > ${marker}; sleep 30`], {
        env: { ...process.env, INTENTIC_QUEUE_DIR: queue, INTENTIC_TURN_OWNER: "holding-conversation", INTENTIC_HEAVY_HELD: "bun-test" },
    });
    const waiter = (): ChildProcess =>
        spawn("bash", [QUEUE_RUN, "--pool", "p", "--limit", "1", "--wait", "30", "--label", "second", "--", "true"], {
            env: { ...process.env, INTENTIC_QUEUE_DIR: queue, INTENTIC_QUEUE_POLL: "1", INTENTIC_TURN_OWNER: "waiting-conversation" },
        });
    let second: ChildProcess | undefined;
    try {
        const until = async (ready: () => Promise<boolean>, what: string): Promise<void> => {
            const deadline = Date.now() + RENDEZVOUS_MS;
            while (!(await ready())) {
                if (Date.now() > deadline) {
                    throw new Error(`${what} never happened, so nothing below is testing what it says`);
                }
                await new Promise((resolve) => setTimeout(resolve, POLL_MS));
            }
        };
        await until(async () => (await readdir(queue)).includes("held-p"), "the holder taking its slot");
        second = waiter();
        await until(async () => (await readdir(join(queue, "p"))).some((name) => name.startsWith("wait.")), "the second command queueing");
        const summary = (await queueSnapshot(queue))["p"];
        expect(summary).toMatchObject({ slots: 1, held: 1, waiting: 1 });
        expect(summary?.holders).toEqual([
            expect.objectContaining({ slot: "slot.1", pid: holder.pid, conversation: "holding-conversation", rule: "bun-test" }),
        ]);
        expect(summary?.waiters).toEqual([expect.objectContaining({ pid: second.pid, label: "second", conversation: "waiting-conversation" })]);
        expect(summary?.longestWaitSeconds).toBeGreaterThanOrEqual(0);
    } finally {
        holder.kill("SIGKILL");
        second?.kill("SIGKILL");
    }
});

// A waiter killed with SIGKILL leaves its file behind, and state.json is only as fresh as its last writer.
test("a waiter whose process is gone is not counted, whichever file still names it", async () => {
    const pool = join(await dir(), "p");
    await mkdir(pool, { recursive: true });
    // Past any pid_max, so certainly not a live process.
    const gone = 2 ** 23;
    const since = Math.floor(Date.now() / 1000) - 60;
    await writeFile(join(pool, `wait.${gone}`), JSON.stringify({ pid: gone, label: "dead", conversation: "c", since, command: "x" }));
    await writeFile(
        join(pool, `wait.${process.pid}`),
        JSON.stringify({ pid: process.pid, label: "live", conversation: "c-live", since, command: "bun test" }),
    );
    await writeFile(
        join(pool, "state.json"),
        JSON.stringify({
            pool: "p",
            limit: 1,
            holders: [{ slot: "slot.1", pid: 77, conversation: "c-h", rule: "tsc" }],
            waiters: [{ pid: gone + 1, since }],
        }),
    );
    const read = await poolQueueFiles(pool, since + 60);
    expect(read.waiters).toEqual([{ pid: process.pid, label: "live", conversation: "c-live", waitSeconds: 60, command: "bun test" }]);
    expect(read.holders.get(77)).toEqual({ conversation: "c-h", rule: "tsc" });
});

test("a missing, half-written or garbage state file reads as nothing waiting", async () => {
    const pool = join(await dir(), "p");
    expect(await poolQueueFiles(pool)).toEqual({ waiters: [], holders: new Map() });
    await mkdir(pool, { recursive: true });
    await writeFile(join(pool, "state.json"), '{"pool":"p","holders":[{"pid":');
    await writeFile(join(pool, `wait.${process.pid}`), "not json");
    expect(await poolQueueFiles(pool)).toEqual({ waiters: [], holders: new Map() });
});
