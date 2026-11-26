import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { LaneRun, QuietLane } from "../../../../system/resources/queue/quiet-lane.js";
import { jobQueueOf } from "../job-queue.js";

// A /proc and a queue root of their own. A pool waiter is kept only while its pid lives in the real /proc
// (queue-slots.ts), so the one waiter here is this test's own process.
const roots: string[] = [];
afterEach(() => {
    for (const root of roots.splice(0)) {
        rmSync(root, { recursive: true, force: true });
    }
});

const scratch = (prefix: string): string => {
    const root = mkdtempSync(join(tmpdir(), prefix));
    roots.push(root);
    return root;
};

const procWith = (processes: Record<number, { argv: string[]; session: number }>): string => {
    const root = scratch("job-queue-proc-");
    for (const [pid, { argv, session }] of Object.entries(processes)) {
        mkdirSync(join(root, pid));
        writeFileSync(join(root, pid, "cmdline"), `${argv.join("\0")}\0`);
        writeFileSync(join(root, pid, "stat"), `${pid} (bash) S 1 ${session} ${session} 34816 ${session} 4194560 0 0 0 0 1 0 0 0 20 0 1 0`);
    }
    return root;
};

const run = (pid: number, conversation: string, seconds: number, label: string): LaneRun => ({ pid, conversation, label, seconds });

test("the job's own processes are told from others' in the lane and the pools, by the session its runner leads", async () => {
    const own = process.pid;
    const proc = procWith({
        40: { argv: ["bash", "/tmp/job-a/runner"], session: 40 },
        41: { argv: ["queue-run", "--pool", "cargo"], session: 40 },
        [own]: { argv: ["queue-run", "--pool", "cargo"], session: 40 },
        90: { argv: ["queue-run", "--exclusive"], session: 90 },
        91: { argv: ["queue-run", "--pool", "cargo"], session: 91 },
    });
    const root = scratch("job-queue-root-");
    mkdirSync(join(root, "cargo"));
    mkdirSync(join(root, ".gate"));
    writeFileSync(
        join(root, "cargo", `wait.${String(own)}`),
        JSON.stringify({
            pid: own,
            label: "cargo-verify",
            conversation: "sub-cod",
            since: Math.floor(Date.now() / 1000) - 90,
            command: "cargo test",
        }),
    );
    const lane: QuietLane = {
        holder: run(90, "sub-grape", 1500, "motion-capture"),
        before: 0,
        waiting: [],
        held: [run(41, "sub-cod", 1320, "cargo-verify"), run(91, "sub-jelly", 1300, "cargo-verify")],
    };

    const queue = await jobQueueOf("/tmp/job-a", lane, { root, procRoot: proc });

    expect(queue?.own).toEqual(new Set([41, own]));
    expect(queue?.slotWaits).toHaveLength(1);
    expect(queue?.slotWaits[0]).toMatchObject({ pool: "cargo", label: "cargo-verify" });
    expect(queue?.slotWaits[0]?.seconds).toBeGreaterThanOrEqual(90);
});

test("a job whose pane is not running waits on nothing", async () => {
    const proc = procWith({ 90: { argv: ["queue-run", "--exclusive"], session: 90 } });
    expect(await jobQueueOf("/tmp/job-a", undefined, { root: scratch("job-queue-root-"), procRoot: proc })).toBeUndefined();
});

test("a root no heavy command ever made has nothing waiting in it", async () => {
    const proc = procWith({ 40: { argv: ["bash", "/tmp/job-a/runner"], session: 40 } });
    expect(await jobQueueOf("/tmp/job-a", undefined, { root: join(scratch("job-queue-root-"), "absent"), procRoot: proc })).toEqual({
        own: new Set(),
        slotWaits: [],
    });
});
