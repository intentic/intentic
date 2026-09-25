import { spawn } from "node:child_process";
import { existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WORKSPACE_ROOT } from "@intentic/constants";
import type { TranscriptRow } from "@intentic/sandbox-contract";
import { pino } from "pino";
import { type LiveRun, RUNS } from "../../agents/actor/conversation-holdings.js";
import type { ListeningPort } from "../../ports/port-scan.js";
import { memoryFleet } from "../../testing.js";
import { bashTmuxHooks } from "./agent-terminals.js";
import {
    type BackgroundJob,
    jobStatusPath,
    noteJobShell,
    noteJobWatch,
    openBackgroundJob,
    settledBackgroundJobs,
    stopBackgroundJob,
    sweepJobEnds,
    wakesItself,
} from "./background-jobs.js";
import { jobFate, resolveTurnJobs, stopJob } from "./job-fates.js";

// What a turn's ending does with what it left running, over real processes: each job here runs under a runner shaped
// exactly like the one bin/tmux-run writes into its pane, leading a session of its own as a tmux pane's root does.

const actors = memoryFleet().conversations;
const logger = pino({ level: "silent" });

const dirs: string[] = [];
const leaders: number[] = [];
afterEach(() => {
    for (const pid of leaders.splice(0)) {
        try {
            process.kill(-pid, "SIGKILL");
        } catch {
            // silent-catch: the session already ended, which is what most tests here make happen.
        }
    }
    for (const dir of dirs.splice(0)) {
        rmSync(dir, { recursive: true, force: true });
    }
});

// bin/tmux-run's runner, minus the tmux options: the command teed into `out`, then its code published by rename.
const RUNNER = (dir: string): string =>
    [
        `bash ${dir}/cmd 2>&1 | tee -a ${dir}/out`,
        "code=${PIPESTATUS[0]}",
        `echo "$code" > ${dir}/status.part`,
        `mv ${dir}/status.part ${dir}/status`,
        "exit $code",
    ].join("\n");

// A running job, and the pid leading its session (its pane, as far as anything here can tell).
const running = async (conversationId: string, command = "exec sleep 60", toolUseId?: string): Promise<{ job: BackgroundJob; leader: number }> => {
    const job = openBackgroundJob(
        { conversationId, profile: {}, conversations: actors },
        { command, session: `agent-${conversationId}`, ...(toolUseId === undefined ? {} : { toolUseId }) },
    );
    if (job === undefined) {
        throw new Error("the job dir could not be minted");
    }
    dirs.push(job.dir);
    writeFileSync(join(job.dir, "cmd"), `${command}\n`);
    writeFileSync(join(job.dir, "runner"), RUNNER(job.dir));
    // detached is setsid: the runner leads a session, as a pane's root process does.
    const child = spawn("bash", [join(job.dir, "runner")], { detached: true, stdio: "ignore" });
    child.unref();
    const leader = child.pid;
    if (leader === undefined) {
        throw new Error("the runner did not start");
    }
    leaders.push(leader);
    // Its command is up once the runner has forked it.
    const deadline = Date.now() + 2_000;
    while (!existsSync(join(job.dir, "out")) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return { job, leader };
};

// A turn's run as the conversation holds it: its rows, under an id each ending judges once.
const turnWith = (conversationId: string, rows: readonly TranscriptRow[], id = `run-${conversationId}`): void => {
    const run = { id, rows, done: false, expired: () => false } as unknown as LiveRun;
    actors.holdings(RUNS).hold(conversationId, conversationId, run);
};

const said = (text: string): TranscriptRow => ({ role: "assistant", text });
const called = (target: string, id = "call-look"): TranscriptRow => ({
    role: "assistant",
    text: "",
    tools: [{ id, name: "Browser navigate", category: "fetch", status: "completed", target }],
});

// The job's pane listening on `port`, the one listener the scan finds.
const listening = (leader: number, port: number) => ({
    conversations: actors,
    logger,
    scanPorts: (): Promise<ListeningPort[]> => Promise.resolve([{ port, host: "127.0.0.1", forwardable: true, pane: leader }]),
});

const card = (conversationId: string, jobId: string) => actors.state(conversationId)?.jobs?.find((entry) => entry.id === jobId);

const ended = async (job: BackgroundJob): Promise<void> => {
    const deadline = Date.now() + 8_000;
    while (!existsSync(jobStatusPath(job)) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 20));
    }
    sweepJobEnds(actors);
};

describe("a job's fate, from what its turn did", () => {
    const none = new Set<number>();

    it("waits on anything that listens on nothing, whatever was said about it", () => {
        expect(jobFate({ ports: [], targets: ["curl localhost:5173"], closing: "It is up at http://localhost:5173", handed: none })).toBe("awaited");
    });

    it("hands over a server the last reply gives the address of, in any of the ways an agent writes one", () => {
        for (const closing of ["Open http://localhost:5173/ to try it", "It's on `127.0.0.1:5173`.", "Serving on :5173", "The dev server is on port 5173."]) {
            expect(jobFate({ ports: [5173], targets: [], closing, handed: none })).toBe("handed");
        }
    });

    it("stops a server the turn reached and said nothing about", () => {
        expect(jobFate({ ports: [47_148], targets: ["http://127.0.0.1:47148/demo/kit"], closing: "The blocks are highlighted now.", handed: none })).toBe(
            "stopped",
        );
        expect(jobFate({ ports: [5173], targets: ["curl -s http://[::1]:5173/"], closing: "Done.", handed: none })).toBe("stopped");
    });

    it("leaves a listener the turn never reached awaited: a test suite's own server, mid-run", () => {
        expect(jobFate({ ports: [34_567], targets: ["pnpm test"], closing: "Tests are running.", handed: none })).toBe("awaited");
    });

    it("does not read a longer port, or a starting command's flag, as the port", () => {
        expect(jobFate({ ports: [5173], targets: ["pnpm dev --port 5173"], closing: "Look at localhost:51730", handed: none })).toBe("awaited");
    });

    it("keeps a port this conversation already handed over, restarted and not named again", () => {
        expect(jobFate({ ports: [5173], targets: ["curl localhost:5173"], closing: "Restarted it.", handed: new Set([5173]) })).toBe("handed");
    });
});

describe("a turn's ending, over a real job", () => {
    it("stops a server the turn used and handed to nobody, frees the land, and wakes nothing", async () => {
        const { job, leader } = await running("conv-fate-stop");
        turnWith("conv-fate-stop", [called("http://127.0.0.1:47148/demo/kit"), said("HTML blocks are highlighted now.")]);
        await resolveTurnJobs(listening(leader, 47_148), "conv-fate-stop");
        // Decided before the processes are gone: the land asks at once.
        expect(wakesItself(actors, "conv-fate-stop")).toBe(false);
        expect(card("conv-fate-stop", job.id)?.stoppedBy).toBe("turn");
        await ended(job);
        expect(readFileSync(jobStatusPath(job), "utf8").trim()).toBe("143");
        expect(card("conv-fate-stop", job.id)).toMatchObject({ stoppedBy: "turn", exitCode: 143 });
        expect(settledBackgroundJobs(actors, "conv-fate-stop")).toEqual({ running: [], unseen: [] });
    });

    it("leaves a server whose address the reply gave running for the person, then stops it when they ask", async () => {
        const { job, leader } = await running("conv-fate-hand");
        turnWith("conv-fate-hand", [called("curl -s localhost:5173"), said("The app is running at http://localhost:5173.")]);
        await resolveTurnJobs(listening(leader, 5173), "conv-fate-hand");
        expect(card("conv-fate-hand", job.id)).toMatchObject({ handed: true, ports: [5173] });
        expect(wakesItself(actors, "conv-fate-hand")).toBe(false);
        // Not handed to a watch: its exit is the person's business now.
        expect(settledBackgroundJobs(actors, "conv-fate-hand").running).toEqual([]);
        expect(existsSync(jobStatusPath(job))).toBe(false);

        expect(await stopJob({ conversations: actors, logger }, job, "person")).toBe(true);
        await ended(job);
        expect(card("conv-fate-hand", job.id)).toMatchObject({ stoppedBy: "person", exitCode: 143 });
        expect(card("conv-fate-hand", job.id)?.handed).toBeUndefined();
    });

    it("leaves a listener the turn never reached awaited, and judges each job once per run", async () => {
        const { job, leader } = await running("conv-fate-await");
        turnWith("conv-fate-await", [said("The suite is still running; I'll pick it up when it finishes.")]);
        await resolveTurnJobs(listening(leader, 34_567), "conv-fate-await");
        expect(card("conv-fate-await", job.id)?.stoppedBy).toBeUndefined();
        expect(wakesItself(actors, "conv-fate-await")).toBe(true);
        expect(settledBackgroundJobs(actors, "conv-fate-await").running.map((entry) => entry.id)).toEqual([job.id]);
        // The settle's second look at the same run judges nothing again, even with the reply now naming it.
        turnWith("conv-fate-await", [said("It's at localhost:34567.")]);
        await resolveTurnJobs(listening(leader, 34_567), "conv-fate-await");
        expect(card("conv-fate-await", job.id)?.handed).toBeUndefined();
    });

    it("disarms the watch an awaited job was handed to before a person's stop ends it", async () => {
        const { job } = await running("conv-fate-watch");
        settledBackgroundJobs(actors, "conv-fate-watch");
        expect(noteJobWatch(actors, job, "watch-ab12")).toBe(true);
        expect(card("conv-fate-watch", job.id)?.watch).toBe("watch-ab12");
        const disarmed: string[] = [];
        await stopBackgroundJob(actors, job, "person", (_conversation, watch) => {
            disarmed.push(watch);
            return Promise.resolve();
        });
        expect(disarmed).toEqual(["watch-ab12"]);
        await ended(job);
        // A watch that arms after the stop has nobody to wake: the adoption is told so, and disarms it.
        expect(noteJobWatch(actors, job, "watch-late")).toBe(false);
    });
});

describe("the agent's own TaskStop", () => {
    it("ends the job it names, where the CLI's stop only reached tmux-run", async () => {
        const { job } = await running("conv-taskstop", "exec sleep 60", "tu-taskstop");
        noteJobShell(actors, "tu-taskstop", "btaskstop1");
        const hooks = bashTmuxHooks([], undefined, undefined, undefined, undefined, undefined, { conversationId: "conv-taskstop", profile: {}, conversations: actors });
        const hook = hooks.PostToolUse?.[0]?.hooks[0];
        if (hook === undefined) {
            throw new Error("no TaskStop hook");
        }
        const input = {
            hook_event_name: "PostToolUse",
            tool_name: "TaskStop",
            tool_input: { task_id: "btaskstop1" },
            tool_response: {},
            tool_use_id: "tu-stop",
            session_id: "s",
            transcript_path: "",
            cwd: WORKSPACE_ROOT,
        } as const;
        await hook(input, "tu-stop", { signal: new AbortController().signal });
        await ended(job);
        expect(card("conv-taskstop", job.id)).toMatchObject({ stoppedBy: "agent", exitCode: 143 });
    });

    it("leaves an id that names none of this conversation's jobs alone: a subagent's, say", async () => {
        const { job } = await running("conv-taskstop-other");
        const hooks = bashTmuxHooks([], undefined, undefined, undefined, undefined, undefined, {
            conversationId: "conv-taskstop-other",
            profile: {},
            conversations: actors,
        });
        const hook = hooks.PostToolUse?.[0]?.hooks[0];
        await hook?.(
            { hook_event_name: "PostToolUse", tool_name: "TaskStop", tool_input: { task_id: "a1b2c3" }, tool_response: {}, tool_use_id: "t", session_id: "s", transcript_path: "", cwd: WORKSPACE_ROOT },
            "t",
            { signal: new AbortController().signal },
        );
        expect(existsSync(jobStatusPath(job))).toBe(false);
    });
});
