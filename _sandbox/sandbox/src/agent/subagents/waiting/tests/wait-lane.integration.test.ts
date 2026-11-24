import type { ChildProcess } from "node:child_process";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AT_THE_TURNSTILE, QUIET_RUN, startQueueRun } from "../../../../system/resources/queue/quiet-lane.testing.js";
import { memoryFleet } from "../../../../conversations/registry/agents-registry.testing.js";
import { openSpawnedChild, resetSubagents } from "../../subagents.js";
import { waitForWork } from "../work-wait.js";

/* (2026-11-24, the shinobi-society fan-out) Children whose timed runs queued behind each other in the quiet lane looked
   idle to the parent waiting on them. A wait that times out now says, for a child whose own command waits there, who
   holds the lane and where it stands, read off a real gate. */

const actors = memoryFleet().conversations;
const before = process.env["INTENTIC_QUEUE_DIR"];
let queue = "";

beforeEach(async () => {
    resetSubagents(actors);
    queue = await mkdtemp(join(tmpdir(), "wait-lane-"));
    process.env["INTENTIC_QUEUE_DIR"] = queue;
});
afterEach(() => {
    if (before === undefined) {
        delete process.env["INTENTIC_QUEUE_DIR"];
    } else {
        process.env["INTENTIC_QUEUE_DIR"] = before;
    }
});

test("a child whose timed run waits in the quiet lane is said to, with who holds it", async () => {
    openSpawnedChild({ conversationId: "conv-q1", conversations: actors, subagentsDir: undefined }, { id: "sub-q1", description: "time the kernels" });
    const started: ChildProcess[] = [];
    try {
        started.push(await startQueueRun(queue, "conv-other", QUIET_RUN, "echo holding; sleep 30", "holding"));
        started.push(await startQueueRun(queue, "sub-q1", QUIET_RUN, "true", AT_THE_TURNSTILE));
        const answered = await waitForWork(actors, "conv-q1", { target: "sub-q1", until: ["finished"], timeoutMs: 20 });
        expect(answered.progress?.[0]).toMatch(/ · its timed run waits for the quiet lane, held by `conv-other` \(`quiet`, \d+s\): position 1 of 1 · /u);
    } finally {
        for (const child of started) {
            child.kill("SIGKILL");
        }
    }
});

test("a child with nothing in the lane reads as before", async () => {
    openSpawnedChild({ conversationId: "conv-q2", conversations: actors, subagentsDir: undefined }, { id: "sub-q2", description: "time the kernels" });
    const answered = await waitForWork(actors, "conv-q2", { target: "sub-q2", until: ["finished"], timeoutMs: 20 });
    expect(answered.progress?.[0]).not.toContain("quiet lane");
});
