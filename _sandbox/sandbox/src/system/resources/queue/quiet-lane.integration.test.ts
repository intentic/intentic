import type { ChildProcess } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readQuietLane } from "./quiet-lane.js";
import { AT_THE_TURNSTILE, QUIET_RUN, startQueueRun } from "./quiet-lane.testing.js";

/* The half the unit tests cannot reach: the gate bin/queue-run really takes, read back off /proc. A wrong descriptor
   number or path parses perfectly and finds nothing, so only a live gate proves the chain. */

test("a quiet run holding the gate, a second one waiting for it and a build held at it are each read off /proc", async () => {
    const queue = await mkdtemp(join(tmpdir(), "quiet-lane-"));
    const started: ChildProcess[] = [];
    try {
        started.push(await startQueueRun(queue, "conv-holder", QUIET_RUN, "echo holding; sleep 30", "holding"));
        started.push(await startQueueRun(queue, "sub-next", QUIET_RUN, "true", AT_THE_TURNSTILE));
        started.push(await startQueueRun(queue, "sub-build", ["--pool", "heavy", "--limit", "2", "--label", "cargo"], "true", AT_THE_TURNSTILE));
        const [holder, next, build] = started;
        const lane = await readQuietLane(queue);
        expect(lane.holder).toEqual(expect.objectContaining({ pid: holder?.pid, conversation: "conv-holder", label: "quiet" }));
        expect(lane.before).toBe(0);
        expect(lane.waiting).toEqual([expect.objectContaining({ pid: next?.pid, conversation: "sub-next", label: "quiet" })]);
        expect(lane.held).toEqual([expect.objectContaining({ pid: build?.pid, conversation: "sub-build", label: "cargo" })]);
    } finally {
        for (const child of started) {
            child.kill("SIGKILL");
        }
    }
});

test("a sandbox that never ran a heavy command reads as a free lane", async () => {
    expect(await readQuietLane(join(await mkdtemp(join(tmpdir(), "quiet-lane-")), "never-ran"))).toEqual({ holder: undefined, before: 0, waiting: [], held: [] });
});
