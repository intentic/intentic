import { readdir } from "node:fs/promises";
import { join } from "node:path";
import { procFile, sessionOf } from "../../../seams/session-processes.js";
import { poolQueueFiles, queueRoot } from "../../../system/resources/queue/queue-slots.js";
import type { QuietLane } from "../../../system/resources/queue/quiet-lane.js";
import { jobRunnerPids } from "../../tools/jobs/job-processes.js";

/* WHAT A RUNNING JOB'S OWN HEAVY COMMAND WAITS ON IN THE QUEUE (2026-11-26, the shinobi-society audit). Children parked
   `wait` on their own `cargo test` jobs for 22 to 43 minutes while a sibling's motion capture ran alone; bin/queue-run
   said why on the command's stderr, which their `> log 2>&1` and `| tail` sent where the wait never showed it. The gate
   (quiet-lane.ts) and the pools' `wait.<pid>` files (queue-slots.ts) already name every waiting process; this tells
   which of them are the job's: everything its pane starts keeps the session its runner leads (job-processes.ts), so a
   process is the job's when its session is that runner. Read when a wait's progress is written, never on a timer. */

// One of the job's processes waiting for a slot in a pool.
export interface JobSlotWait {
    readonly pool: string;
    readonly label: string | undefined;
    readonly seconds: number;
}

export interface JobQueue {
    // The job's processes among those the lane names, for quietLaneJobWords.
    readonly own: ReadonlySet<number>;
    readonly slotWaits: readonly JobSlotWait[];
}

// Every pool directory queue-run made under the root; `.gate` is the gate's, not a pool.
const poolNames = async (root: string): Promise<string[]> =>
    // allow(silent-catch): a root no heavy command ever made has no pools, which is what an empty list says
    (await readdir(root, { withFileTypes: true }).catch(() => []))
        .filter((entry) => entry.isDirectory() && !entry.name.startsWith("."))
        .map((entry) => entry.name);

/** What the job in `dir` waits on in the queue now; undefined when its pane is not running. */
export const jobQueueOf = async (
    dir: string,
    lane: QuietLane | undefined,
    { root = queueRoot(), procRoot = "/proc" }: { readonly root?: string; readonly procRoot?: string } = {},
): Promise<JobQueue | undefined> => {
    const leader = (await jobRunnerPids([dir], procRoot)).get(dir);
    if (leader === undefined) {
        return undefined;
    }
    const pools = await Promise.all(
        (await poolNames(root)).map(async (pool) => ({ pool, waiters: (await poolQueueFiles(join(root, pool))).waiters })),
    );
    const lanePids = lane === undefined ? [] : [lane.holder, ...lane.waiting, ...lane.held].flatMap((run) => (run === undefined ? [] : [run.pid]));
    const candidates = new Set([...lanePids, ...pools.flatMap(({ waiters }) => waiters.map((waiter) => waiter.pid))]);
    const own = new Set<number>();
    await Promise.all(
        [...candidates].map(async (pid) => {
            if (pid === leader || sessionOf(await procFile(join(procRoot, String(pid), "stat"))) === leader) {
                own.add(pid);
            }
        }),
    );
    const slotWaits = pools.flatMap(({ pool, waiters }) =>
        waiters.filter((waiter) => own.has(waiter.pid)).map((waiter) => ({ pool, label: waiter.label, seconds: waiter.waitSeconds })),
    );
    return { own, slotWaits };
};
