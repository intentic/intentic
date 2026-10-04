import { spawn } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WORKSPACE_ROOT } from "@intentic/constants";
import type { TranscriptRow } from "@intentic/sandbox-contract";
import { pino } from "pino";
import { type LiveRun, RUNS } from "../../../conversations/actor/conversation-holdings.js";
import type { ListeningPort } from "../../../ports/port-scan.js";
import { memoryFleet } from "../../../testing.js";
import { bashTmuxHooks } from "../agent-terminals.js";
import {
    type BackgroundJob,
    jobStatusPath,
    keepBackgroundJob,
    noteJobShell,
    noteJobWatch,
    openBackgroundJob,
    settledBackgroundJobs,
    settleLostRuns,
    stopBackgroundJob,
    sweepJobEnds,
} from "./background-jobs.js";
import { requires } from "@intentic/testing/requires";
import { INPUT_WAIT_MS } from "./input-wait.js";
import { lookAtRuns } from "./input-wait-follow.js";
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
            // allow(silent-catch): the session already ended, which is what most tests here make happen.
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

// `script` gives the runner a terminal of its own, as a tmux pane does; its stdin is a pipe held open, so it never hands
// the program an end of input.
const terminal = requires(existsSync("/usr/bin/script"), "util-linux script at /usr/bin/script");

// A running job whose runner's stdin is a terminal, as a pane's is.
const runningOnTerminal = async (conversationId: string, command: string): Promise<{ job: BackgroundJob; leader: number }> => {
    const job = openBackgroundJob({ conversationId, profile: {}, conversations: actors }, { command, session: `agent-${conversationId}` });
    if (job === undefined) {
        throw new Error("the job dir could not be minted");
    }
    dirs.push(job.dir);
    writeFileSync(join(job.dir, "cmd"), `${command}\n`);
    writeFileSync(join(job.dir, "runner"), RUNNER(job.dir));
    // SHELL=bash: script runs `$SHELL -c`, and bash execs a lone command, so the runner itself leads the session.
    const child = spawn("script", ["-qfc", `bash ${join(job.dir, "runner")}`, "/dev/null"], {
        detached: true,
        stdio: ["pipe", "ignore", "ignore"],
        env: { ...process.env, SHELL: "/bin/bash" },
    });
    child.unref();
    if (child.pid === undefined) {
        throw new Error("script did not start");
    }
    leaders.push(child.pid);
    const deadline = Date.now() + 2_000;
    while (!existsSync(join(job.dir, "out")) && Date.now() < deadline) {
        await new Promise((resolve) => setTimeout(resolve, 10));
    }
    return { job, leader: child.pid };
};

// Looks at the job on a clock running ahead of the real one, past the stillness a prompt needs, until its card says it is
// waiting or the program has had every chance to reach its prompt.
const untilWaiting = async (conversationId: string, job: BackgroundJob): Promise<void> => {
    const deadline = Date.now() + 5_000;
    let ahead = Date.now() + 10_000;
    while (card(conversationId, job.id)?.inputWait === undefined && Date.now() < deadline) {
        await lookAtRuns("/proc", ahead);
        ahead += INPUT_WAIT_MS;
        await new Promise((resolve) => setTimeout(resolve, 50));
    }
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

    it("hands over whatever the agent kept, reached or not, listening or not", () => {
        expect(jobFate({ kept: true, ports: [5173], targets: ["curl -s localhost:5173"], handed: none, waiting: false })).toBe("handed");
        expect(jobFate({ kept: true, ports: [5173], targets: [], handed: none, waiting: false })).toBe("handed");
        expect(jobFate({ kept: true, ports: [], targets: [], handed: none, waiting: false })).toBe("handed");
    });

    it("waits on anything unkept that listens on nothing", () => {
        expect(jobFate({ kept: false, ports: [], targets: ["curl localhost:5173"], handed: none, waiting: false })).toBe("awaited");
    });

    it("stops an unkept server the turn reached", () => {
        expect(jobFate({ kept: false, ports: [47_148], targets: ["http://127.0.0.1:47148/demo/kit"], handed: none, waiting: false })).toBe("stopped");
        expect(jobFate({ kept: false, ports: [5173], targets: ["curl -s http://[::1]:5173/"], handed: none, waiting: false })).toBe("stopped");
    });

    it("leaves an unkept listener the turn never reached awaited: a test suite's own server, mid-run", () => {
        expect(jobFate({ kept: false, ports: [34_567], targets: ["pnpm test"], handed: none, waiting: false })).toBe("awaited");
    });

    it("does not read a longer port, or a starting command's flag, as the port", () => {
        expect(jobFate({ kept: false, ports: [5173], targets: ["pnpm dev --port 5173", "curl localhost:51730"], handed: none, waiting: false })).toBe("awaited");
    });

    it("keeps a port this conversation already handed over, restarted and not kept again", () => {
        expect(jobFate({ kept: false, ports: [5173], targets: ["curl localhost:5173"], handed: new Set([5173]), waiting: false })).toBe("handed");
    });

    it("stops one sitting at a prompt that nobody kept, since no agent is left to answer it", () => {
        expect(jobFate({ kept: false, ports: [], targets: [], handed: none, waiting: true })).toBe("stopped");
        expect(jobFate({ kept: false, ports: [], targets: [], handed: none, waiting: false })).toBe("awaited");
    });

    it("still hands over one the agent kept for the person, prompt or not: answering it is theirs", () => {
        expect(jobFate({ kept: true, ports: [], targets: [], handed: none, waiting: true })).toBe("handed");
    });
});

describe("keeping a job for the person", () => {
    it("records the keep on a running job by the id its Bash call returned, and refuses what cannot be kept", async () => {
        const { job } = await running("conv-keep", "exec sleep 60", "tu-keep");
        noteJobShell(actors, "tu-keep", "bkeep1");
        expect(keepBackgroundJob(actors, "conv-keep", "bkeep1", "dev server")).toBe("kept");
        expect(keepBackgroundJob(actors, "conv-keep", "b-nobody", "dev server")).toBe("unknown");
        expect(keepBackgroundJob(actors, "conv-other", "bkeep1", "dev server")).toBe("unknown");
        expect(await stopBackgroundJob(actors, job, "agent")).toBe(true);
        expect(keepBackgroundJob(actors, "conv-keep", "bkeep1", "dev server")).toBe("ended");
    });
});

describe("a turn's ending, over a real job", () => {
    // 2026-10-04: an `npx eslint` asked "Ok to proceed? (y)" into a `| tail`, the turn ended on it, and a six-hour watch
    // held the conversation's land behind a question nobody would answer.
    test.skipIf(!terminal.runs)(terminal.title("stops a job left at a prompt instead of waiting six hours on it, and the card said why first"), async () => {
        const { job } = await runningOnTerminal("conv-fate-prompt", `read -p "Ok to proceed? (y) " answer 2>&1 | tail -10`);
        await untilWaiting("conv-fate-prompt", job);
        expect(card("conv-fate-prompt", job.id)?.inputWait).toEqual({ since: expect.any(Number), program: `bash ${join(job.dir, "cmd")}` });
        turnWith("conv-fate-prompt", [said("The typecheck is still running; I'll report when it finishes.")]);
        await resolveTurnJobs({ conversations: actors, logger, scanPorts: () => Promise.resolve([]) }, "conv-fate-prompt");
        expect(card("conv-fate-prompt", job.id)?.stoppedBy).toBe("turn");
        // Nothing left to hand a watch, so nothing holds the land.
        expect(settledBackgroundJobs(actors, "conv-fate-prompt").running).toEqual([]);
        await ended(job);
        expect(card("conv-fate-prompt", job.id)).toMatchObject({ stoppedBy: "turn", exitCode: 143 });
        expect(card("conv-fate-prompt", job.id)?.inputWait).toBeUndefined();
    });

    it("stops a server the turn used and handed to nobody, frees the land, and wakes nothing", async () => {
        const { job, leader } = await running("conv-fate-stop");
        turnWith("conv-fate-stop", [called("http://127.0.0.1:47148/demo/kit"), said("HTML blocks are highlighted now.")]);
        await resolveTurnJobs(listening(leader, 47_148), "conv-fate-stop");
        // Decided before the processes are gone: the close arms wakes next, and this one is handed to none.
        expect(card("conv-fate-stop", job.id)?.stoppedBy).toBe("turn");
        expect(settledBackgroundJobs(actors, "conv-fate-stop").running).toEqual([]);
        await ended(job);
        expect(readFileSync(jobStatusPath(job), "utf8").trim()).toBe("143");
        expect(card("conv-fate-stop", job.id)).toMatchObject({ stoppedBy: "turn", exitCode: 143 });
        expect(settledBackgroundJobs(actors, "conv-fate-stop")).toEqual({ running: [], unseen: [] });
    });

    // The review's four replies: three hand a server over and one does not, and no reading of the words told them apart.
    // Each decides by the keep alone, kept or not.
    const REPLIES = [
        "I stopped the old dev server and started a fresh one at http://localhost:5173 for you.",
        "It's running at http://localhost:5173, leave it up and kill it when done.",
        "It is up at localhost:5173, open it in Preview.",
        "I stopped the server on localhost:5173.",
    ];
    for (const [index, reply] of REPLIES.entries()) {
        for (const kept of [true, false]) {
            it(`${kept ? "hands over" : "stops"} a server it reached that was ${kept ? "" : "not "}kept, replying "${reply}"`, async () => {
                const conversationId = `conv-fate-reply-${String(index)}-${kept ? "kept" : "unkept"}`;
                const { job, leader } = await running(conversationId);
                if (kept) {
                    expect(keepBackgroundJob(actors, conversationId, job.id, "dev server for the person")).toBe("kept");
                }
                turnWith(conversationId, [called("curl -s localhost:5173"), said(reply)]);
                await resolveTurnJobs(listening(leader, 5173), conversationId);
                if (kept) {
                    expect(card(conversationId, job.id)).toMatchObject({ handed: true, ports: [5173] });
                    expect(card(conversationId, job.id)?.stoppedBy).toBeUndefined();
                } else {
                    expect(card(conversationId, job.id)?.stoppedBy).toBe("turn");
                    expect(card(conversationId, job.id)?.handed).toBeUndefined();
                }
            });
        }
    }

    it("leaves a server the agent kept running for the person, then stops it when they ask", async () => {
        const { job, leader } = await running("conv-fate-hand");
        expect(keepBackgroundJob(actors, "conv-fate-hand", job.id, "the app for the person")).toBe("kept");
        turnWith("conv-fate-hand", [called("curl -s localhost:5173"), said("Done.")]);
        await resolveTurnJobs(listening(leader, 5173), "conv-fate-hand");
        expect(card("conv-fate-hand", job.id)).toMatchObject({ handed: true, ports: [5173] });
        // Not handed to a watch: its exit is the person's business now.
        expect(settledBackgroundJobs(actors, "conv-fate-hand").running).toEqual([]);
        expect(existsSync(jobStatusPath(job))).toBe(false);

        expect(await stopJob({ conversations: actors, logger }, job, "person")).toBe(true);
        await ended(job);
        expect(card("conv-fate-hand", job.id)).toMatchObject({ stoppedBy: "person", exitCode: 143 });
        expect(card("conv-fate-hand", job.id)?.handed).toBeUndefined();
    });

    // One judgement per run is the close's (turn-placement.test.ts); a later run's ending judges an awaited job again.
    it("leaves a listener the turn never reached awaited, and a later run that kept it hands it over", async () => {
        const { job, leader } = await running("conv-fate-await");
        turnWith("conv-fate-await", [said("The suite is still running; I'll pick it up when it finishes.")]);
        await resolveTurnJobs(listening(leader, 34_567), "conv-fate-await");
        expect(card("conv-fate-await", job.id)?.stoppedBy).toBeUndefined();
        expect(settledBackgroundJobs(actors, "conv-fate-await").running.map((entry) => entry.id)).toEqual([job.id]);
        expect(keepBackgroundJob(actors, "conv-fate-await", job.id, "the app for the person")).toBe("kept");
        turnWith("conv-fate-await", [called("curl -s localhost:34567"), said("It's up.")]);
        await resolveTurnJobs(listening(leader, 34_567), "conv-fate-await");
        expect(card("conv-fate-await", job.id)).toMatchObject({ handed: true, ports: [34_567] });
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

// 2026-10-04: a container restart killed an overrun `npm exec` mid-prompt, and the daemon re-armed the watch on it for two
// and a half more hours, waiting on a status no runner was left to write.
describe("a restart under a job", () => {
    it("writes down the end of every run it took down, and leaves the finished, the living and the unfiled alone", async () => {
        const root = mkdtempSync(join(tmpdir(), "settle-lost-"));
        dirs.push(root);
        const run = (name: string, files: Record<string, string>): string => {
            const dir = join(root, `intentic-run-${name}`);
            mkdirSync(dir);
            for (const [file, body] of Object.entries(files)) {
                writeFileSync(join(dir, file), body);
            }
            return dir;
        };
        const lost = run("lost", { "job.json": "{}", cmd: "npx eslint\n", out: "Need to install the following packages:\n" });
        const done = run("done", { "job.json": "{}", cmd: "true\n", out: "", status: "0\n" });
        const unstarted = run("job-unstarted", { "job.json": "{}" });
        const plain = run("plain", { cmd: "ls\n", out: "" });
        const living = run("living", { "job.json": "{}", cmd: "sleep 60\n", out: "", runner: "sleep 60\n" });
        const child = spawn("bash", [join(living, "runner")], { detached: true, stdio: "ignore" });
        child.unref();
        leaders.push(child.pid ?? 0);
        // Its runner stays bash (as tmux-run's does, never exec-ing), whose command line is what marks it alive.
        await new Promise((resolve) => setTimeout(resolve, 200));

        expect((await settleLostRuns(root)).toSorted()).toEqual([lost, unstarted].toSorted());
        expect(readFileSync(join(lost, "status"), "utf8")).toBe("lost\n");
        expect(readFileSync(join(lost, "out"), "utf8")).toBe(
            "Need to install the following packages:\n\n--- intentic: the sandbox restarted while this ran, and the command did not survive the restart\n",
        );
        expect(readFileSync(join(unstarted, "status"), "utf8")).toBe("never-ran\n");
        expect(readFileSync(join(done, "status"), "utf8")).toBe("0\n");
        expect(existsSync(join(plain, "status"))).toBe(false);
        expect(existsSync(join(living, "status"))).toBe(false);
    });
});
