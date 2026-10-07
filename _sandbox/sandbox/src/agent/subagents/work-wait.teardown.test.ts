import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import * as fileAppearsOriginal from "../tools/file-appears.js";
import * as backgroundJobsOriginal from "../tools/jobs/background-jobs.js";
import { memoryFleet } from "../../testing.js";

// What a wait on commands leaves behind once it has answered, however it answered. A job's watch is an inotify handle on
// its directory, so one left open outlives the wait until the job ends; these count the watches still open.

const realWhenFileAppears = fileAppearsOriginal.whenFileAppears;
const realJobInputWait = backgroundJobsOriginal.jobInputWait;

const open = new Set<string>();
jest.mock("../tools/file-appears.js", () => ({
    ...fileAppearsOriginal,
    whenFileAppears: (path: string, onAppear: () => void) => {
        const stop = realWhenFileAppears(path, onAppear);
        if (stop === undefined) {
            return undefined;
        }
        open.add(path);
        return () => {
            open.delete(path);
            stop();
        };
    },
}));

// The job already at a prompt, as the input-wait follower reports one; finding it for real takes a terminal and /proc
// (input-wait.integration.test.ts).
let prompting: string | undefined;
jest.mock("../tools/jobs/background-jobs.js", () => ({
    ...backgroundJobsOriginal,
    jobInputWait: (job: backgroundJobsOriginal.BackgroundJob) => (job.dir === prompting ? { since: 0, pid: 4242, program: "npx create-thing" } : realJobInputWait(job)),
}));

const { noteJobShell, openBackgroundJob } = await import("../tools/jobs/background-jobs.js");
const { openSpawnedChild, resetSubagents, settleSpawnedChild } = await import("./subagents.js");
const { waitForWork } = await import("./work-wait.js");

const actors = memoryFleet().conversations;

const dirs: string[] = [];
beforeEach(() => {
    resetSubagents(actors);
    prompting = undefined;
});
afterEach(() => {
    for (const dir of dirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
    open.clear();
});

const job = (conversationId: string, toolUseId: string, shellId: string): backgroundJobsOriginal.BackgroundJob => {
    const opened = openBackgroundJob({ conversationId, profile: {}, conversations: actors }, { command: "npx create-thing", session: `agent-${conversationId}`, toolUseId });
    if (opened === undefined) {
        throw new Error("the job dir could not be minted");
    }
    dirs.push(opened.dir);
    noteJobShell(actors, toolUseId, shellId);
    return opened;
};

// The repeat-wait case: an agent asked again and again about the same `npx` at "Ok to proceed? (y)", each answer at once.
it("a wait on a command already at a prompt answers blocked at once, and leaves no watch open on its directory", async () => {
    const asking = job("conv-t1", "tu-t1", "bsh-t1");
    prompting = asking.dir;
    expect(await waitForWork(actors, "conv-t1", { target: "bsh-t1", until: ["blocked", "finished"], timeoutMs: 5_000 })).toMatchObject({
        outcome: "blocked",
        job: { id: "bsh-t1", running: true },
    });
    expect([...open]).toEqual([]);
});

it("every other way a wait on a command ends closes its watch too: finished, timeout, the turn's abort", async () => {
    const built = job("conv-t2", "tu-t2", "bsh-t2");
    const finished = waitForWork(actors, "conv-t2", { target: "bsh-t2", until: ["finished"], timeoutMs: 5_000 });
    expect([...open]).toHaveLength(1);
    writeFileSync(join(built.dir, "status"), "0\n");
    expect(await finished).toMatchObject({ outcome: "finished" });
    expect([...open]).toEqual([]);

    job("conv-t3", "tu-t3", "bsh-t3");
    expect(await waitForWork(actors, "conv-t3", { target: "bsh-t3", until: ["finished"], timeoutMs: 20 })).toMatchObject({ outcome: "timeout" });
    expect([...open]).toEqual([]);

    job("conv-t4", "tu-t4", "bsh-t4");
    const controller = new AbortController();
    const stopped = waitForWork(actors, "conv-t4", { target: "bsh-t4", until: ["finished"], timeoutMs: 5_000, signal: controller.signal });
    controller.abort();
    expect(await stopped).toMatchObject({ outcome: "aborted" });
    expect([...open]).toEqual([]);
});

// For "any", the commands race the children; the loser is stopped through the link to the winner's answer.
it("a wait on any that a child answers first closes the watch on the command it raced", async () => {
    job("conv-t5", "tu-t5", "bsh-t5");
    openSpawnedChild({ conversationId: "conv-t5", conversations: actors, subagentsDir: undefined }, { id: "sub-t5", description: "port it" });
    const wait = waitForWork(actors, "conv-t5", { until: ["finished"], timeoutMs: 5_000 });
    expect([...open]).toHaveLength(1);
    settleSpawnedChild(actors, "sub-t5", { status: "completed", report: "ported" });
    expect(await wait).toMatchObject({ outcome: "finished", agent: { id: "sub-t5" } });
    expect([...open]).toEqual([]);
});
