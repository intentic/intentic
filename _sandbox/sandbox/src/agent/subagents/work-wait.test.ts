import { rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { SteeringQueue } from "../checkpoints/agent-steering.js";
import { type BackgroundJob, noteJobShell, openBackgroundJob } from "../tools/jobs/background-jobs.js";
import { noteSpawnedChild, openSpawnedChild, resetSubagents, settleSpawnedChild, subagentEndingReporter } from "./subagents.js";
import { noteQueuedReport } from "./queued-reports.js";
import { waitForWork, workWaitAnswer } from "./work-wait.js";
import { memoryFleet } from "../../testing.js";

// One fleet's actors, which hold every record the registry under test files.
const actors = memoryFleet().conversations;

// A background command is waitable work, not an unknown target.

const dirs: string[] = [];
beforeEach(() => resetSubagents(actors));
afterEach(() => {
    for (const dir of dirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

const job = (conversationId: string, toolUseId: string, shellId: string): BackgroundJob => {
    const opened = openBackgroundJob(
        { conversationId, profile: {}, conversations: actors },
        { command: "pnpm build", session: `agent-${conversationId}`, toolUseId },
    );
    if (opened === undefined) {
        throw new Error("the job dir could not be minted");
    }
    dirs.push(opened.dir);
    noteJobShell(actors, toolUseId, shellId);
    return opened;
};

const finish = (target: BackgroundJob, code: string, output: string): void => {
    writeFileSync(join(target.dir, "out"), output);
    writeFileSync(join(target.dir, "status"), `${code}\n`);
};

describe("waitForWork", () => {
    it("parks on a background command named by the id its Bash call returned, and answers with how it ended", async () => {
        const build = job("conv-w1", "tu-w1", "bsh-w1");
        const wait = waitForWork(actors, "conv-w1", { target: "bsh-w1", until: ["blocked", "finished"], timeoutMs: 5_000 });
        finish(build, "1", "error TS2345\n");
        expect(await wait).toMatchObject({ outcome: "finished", job: { id: "bsh-w1", exitCode: 1, running: false, outputTail: "error TS2345\n" } });
    });

    it("answers a timeout with the command's state so far", async () => {
        const build = job("conv-w2", "tu-w2", "bsh-w2");
        writeFileSync(join(build.dir, "out"), "compiling…\n");
        expect(await waitForWork(actors, "conv-w2", { target: "bsh-w2", until: ["finished"], timeoutMs: 20 })).toMatchObject({
            outcome: "timeout",
            job: { id: "bsh-w2", running: true, outputTail: "compiling…\n" },
        });
    });

    it("with no target, a command finishing ends the wait even with no child to wait on", async () => {
        const build = job("conv-w3", "tu-w3", "bsh-w3");
        const wait = waitForWork(actors, "conv-w3", { until: ["blocked", "finished"], timeoutMs: 5_000 });
        finish(build, "0", "built\n");
        expect(await wait).toMatchObject({ outcome: "finished", job: { id: "bsh-w3", exitCode: 0 } });
    });

    it("with no target, a child moving first ends the wait, not the command still running", async () => {
        job("conv-w4", "tu-w4", "bsh-w4");
        openSpawnedChild(
            { conversationId: "conv-w4", conversations: actors, subagentsDir: undefined },
            { id: "sub-w4", description: "port it" },
        );
        const wait = waitForWork(actors, "conv-w4", { until: ["finished"], timeoutMs: 5_000 });
        settleSpawnedChild(actors, "sub-w4", { status: "completed", report: "ported" });
        expect(await wait).toMatchObject({ outcome: "finished", agent: { id: "sub-w4" } });
    });

    it("never parks on another conversation's command", async () => {
        job("conv-w5-other", "tu-w5", "bsh-w5");
        expect(await waitForWork(actors, "conv-w5", { target: "bsh-w5", until: ["finished"], timeoutMs: 5_000 })).toMatchObject({
            outcome: "unknown-target",
        });
    });

    // A runtime reads steered words only between tool calls, so a wait parked for half an hour would sit on the owner's
    // message, a watch that fired or a land for that long.
    it("words said into the waiting turn hand it back with outcome `message`, leaving the child it waited on unreported", async () => {
        const unregister = actors.registerTurn("conv-w7", { abort: () => {}, steering: new SteeringQueue() });
        openSpawnedChild(
            { conversationId: "conv-w7", conversations: actors, subagentsDir: undefined },
            { id: "sub-w7", description: "port it" },
        );
        try {
            const wait = waitForWork(actors, "conv-w7", { until: ["finished"], timeoutMs: 10_000 });
            expect(actors.steer("conv-w7", "Stop after this phase, I need to review it.")).toBe(true);
            expect(await wait).toEqual({ outcome: "message" });
            settleSpawnedChild(actors, "sub-w7", { status: "completed", report: "ported" });
            expect(await waitForWork(actors, "conv-w7", { until: ["finished"], timeoutMs: 5_000 })).toMatchObject({ outcome: "finished", agent: { id: "sub-w7" } });
        } finally {
            unregister();
        }
    });

    it("words said into another conversation's turn leave the wait parked", async () => {
        const unregister = actors.registerTurn("conv-w8-other", { abort: () => {}, steering: new SteeringQueue() });
        openSpawnedChild(
            { conversationId: "conv-w8", conversations: actors, subagentsDir: undefined },
            { id: "sub-w8", description: "port it" },
        );
        try {
            const wait = waitForWork(actors, "conv-w8", { until: ["finished"], timeoutMs: 2_500 });
            expect(actors.steer("conv-w8-other", "Not for you.")).toBe(true);
            expect(await wait).toMatchObject({ outcome: "timeout" });
        } finally {
            unregister();
        }
    });

    it("the turn's abort settles a wait on a command", async () => {
        job("conv-w6", "tu-w6", "bsh-w6");
        const controller = new AbortController();
        const wait = waitForWork(actors, "conv-w6", { target: "bsh-w6", until: ["finished"], timeoutMs: 5_000, signal: controller.signal });
        controller.abort();
        expect(await wait).toMatchObject({ outcome: "aborted" });
    });
});

describe("a child's ending reaches its parent once", () => {
    const opened = (conversationId: string, id: string): void =>
        openSpawnedChild(
            { conversationId, conversations: actors, subagentsDir: undefined },
            { id, description: "port it" },
        );

    // The parent was busy with a turn that takes no words, so the report waited in its queue; a wait that hands the same
    // ending over takes the queued copy back out.
    it("a wait that hands over an ending takes the copy of its report still queued for the parent back out", async () => {
        opened("conv-q1", "sub-q1");
        await actors.send("conv-q1", {
            kind: "queue-joined",
            item: { id: "child-report-1", voice: "sandbox", queuedAt: 1, turn: { conversationId: "conv-q1", prompt: "Report from a subagent", messageId: "child-report-1" } },
        }).settled;
        noteQueuedReport(actors, "sub-q1", { parent: "conv-q1", messageId: "child-report-1" });
        settleSpawnedChild(actors, "sub-q1", { status: "completed", report: "ported" });
        expect(await waitForWork(actors, "conv-q1", { until: ["finished"], timeoutMs: 5_000 })).toMatchObject({ outcome: "finished", agent: { id: "sub-q1" } });
        expect(actors.queued("conv-q1").items.map((item) => item.id)).toEqual([]);
    });

    // The turn's own ending can reach the parent as a report a moment before the child's row settles: the row then
    // settles as handed over, and a wait on "any" does not hand it over a second time.
    it("a report delivered before the row settles files its ending as handed over when it does", async () => {
        opened("conv-q2", "sub-q2");
        subagentEndingReporter(actors, "sub-q2")();
        settleSpawnedChild(actors, "sub-q2", { status: "failed", report: "", error: "boom" });
        expect(await waitForWork(actors, "conv-q2", { until: ["finished"], timeoutMs: 20 })).toMatchObject({ outcome: "unknown-target" });
    });

    it("a report about a turn a follow-up has since replaced leaves the follow-up's ending to be told", async () => {
        opened("conv-q3", "sub-q3");
        const reported = subagentEndingReporter(actors, "sub-q3");
        settleSpawnedChild(actors, "sub-q3", { status: "completed", report: "first" });
        // The follow-up reopens the row before the first turn's report finished its delivery.
        openSpawnedChild(
            { conversationId: "conv-q3", conversations: actors, subagentsDir: undefined },
            { id: "sub-q3", description: "port it", again: true },
        );
        reported();
        settleSpawnedChild(actors, "sub-q3", { status: "completed", report: "second" });
        expect(await waitForWork(actors, "conv-q3", { until: ["finished"], timeoutMs: 5_000 })).toMatchObject({
            outcome: "finished",
            agent: { id: "sub-q3", summary: "second" },
        });
    });

    it("a paused child is a move a wait hands over, never an ending: a wait for `finished` alone keeps parking", async () => {
        opened("conv-q4", "sub-q4");
        noteSpawnedChild(actors, "sub-q4", { status: "paused", summary: "Paused, not finished.", error: "out of usage" });
        expect(await waitForWork(actors, "conv-q4", { until: ["finished"], timeoutMs: 20 })).toMatchObject({ outcome: "timeout" });
        expect(await waitForWork(actors, "conv-q4", { until: ["blocked", "finished"], timeoutMs: 5_000 })).toMatchObject({
            outcome: "blocked",
            agent: { id: "sub-q4", status: "paused", error: "out of usage" },
        });
    });
});

describe("what a wait answers with", () => {
    const agent = { id: "sub-a", kind: "spawned", conversationId: "conv-a", startedAt: 1, activityAt: 2, summary: "Head of it" } as const;
    const lookups = (report: string | undefined, landing?: string) => ({ pendingQuestion: () => undefined, report: () => report, landing: () => landing });

    it("hands an ended child's whole report over where its row's summary cut it", () => {
        expect(workWaitAnswer({ outcome: "finished", agent: { ...agent, status: "completed" } }, lookups("Head of it, and the whole rest of it."))).toEqual({
            outcome: "finished",
            agent: { ...agent, status: "completed" },
            report: "Head of it, and the whole rest of it.",
        });
    });

    // Where its work went rides beside the report, once the child has ended: in the waiter's checkout, or held off it.
    it("hands an ended child's landing over, and none for one still working", () => {
        const landing = "Its changes (1 file) are in your checkout now.";
        expect(workWaitAnswer({ outcome: "finished", agent: { ...agent, status: "completed" } }, lookups("Head of it", landing))).toEqual({
            outcome: "finished",
            agent: { ...agent, status: "completed" },
            landing,
        });
        expect(workWaitAnswer({ outcome: "timeout", agent: { ...agent, status: "running" } }, lookups("Head of it", landing))).toEqual({
            outcome: "timeout",
            agent: { ...agent, status: "running" },
        });
    });

    it("adds nothing where the summary already is the whole report, or the child has not ended", () => {
        expect(workWaitAnswer({ outcome: "finished", agent: { ...agent, status: "completed" } }, lookups("Head of it"))).toEqual({
            outcome: "finished",
            agent: { ...agent, status: "completed" },
        });
        expect(workWaitAnswer({ outcome: "timeout", agent: { ...agent, status: "running" } }, lookups("Head of it, and more."))).toEqual({
            outcome: "timeout",
            agent: { ...agent, status: "running" },
        });
    });
});
