import { readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { WORKSPACE_ROOT } from "@intentic/constants";
import { memoryFleet } from "../../conversations/registry/agents-registry.testing.js";
import { backgroundJobOf, settledBackgroundJobs } from "../../agent/tools/jobs/background-jobs.js";
import { createShellLines } from "./shell-line.js";

// The one command runner a judged loop's shell goes through (Codex's command, Pi's bash): a line that comes back from the
// panel still running is filed as a background job the agent waits on, as a Claude Code turn's Bash is.

const actors = memoryFleet().conversations;
const SESSION = "3f2a9b1c-0000-0000-0000-000000000000";
const signal = new AbortController().signal;

// The run dir a rewritten line names with `-f`.
const runDir = (command: string): string => dirname((/ -f (\S+) /u.exec(command)?.[1] ?? "").replaceAll("'", ""));

const linesFor = (conversationId: string, filesJobs = true) =>
    createShellLines({
        tools: {},
        isolation: undefined,
        owner: conversationId,
        terminals: true,
        mask: false,
        jobs: filesJobs ? { conversationId, profile: {}, conversations: actors } : undefined,
    });

const lineThrough = async (lines: ReturnType<typeof linesFor>, command: string, id: string): Promise<string> => {
    const outcome = await lines.line(command, { session: SESSION, cwd: WORKSPACE_ROOT, id }, signal);
    if (!("command" in outcome)) {
        throw new Error(`refused: ${outcome.refuse}`);
    }
    return runDir(outcome.command);
};

test("a line the panel returned still running is filed as a job, and the agent is told its id to wait on", async () => {
    const lines = linesFor("conv-shell-overrun");
    const dir = await lineThrough(lines, "cargo build --release", "call-1");
    expect(readFileSync(join(dir, "said"), "utf8")).toBe("cargo build --release");
    // What tmux-run leaves for a command still running: its own files, and no status yet.
    writeFileSync(join(dir, "cmd"), "cargo build --release\n");
    writeFileSync(join(dir, "out"), "Compiling integra\n");

    const told = (await lines.settle("call-1", `Compiling integra\n\n--- command still running in tmux window run · output so far: ${dir}/out\n`, signal)) ?? "";

    const id = /background job (\S+)\./u.exec(told)?.[1] ?? "";
    expect(backgroundJobOf(actors, "conv-shell-overrun", id)?.dir).toBe(dir);
    expect(told).toContain(`Wait for it with the \`wait\` tool (target "${id}")`);
    expect(told).toContain(`the \`stop\` tool (target "${id}")`);
    expect(settledBackgroundJobs(actors, "conv-shell-overrun").running.map((job) => job.id)).toEqual([id]);
    // Each call is settled once.
    expect(await lines.settle("call-1", "--- command still running in tmux window run · output so far: x", signal)).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
    await lines.dispose();
});

test("a line that finished, a call the panel never ran, and a turn with nowhere to deliver a wake file nothing", async () => {
    const lines = linesFor("conv-shell-finished");
    await lineThrough(lines, "ls", "call-2");
    expect(await lines.settle("call-2", "a\nb\n", signal)).toBeUndefined();
    expect(await lines.settle("never-ran", "--- command still running in tmux window run · output so far: x", signal)).toBeUndefined();
    expect(settledBackgroundJobs(actors, "conv-shell-finished")).toEqual({ running: [], unseen: [] });

    const jobless = linesFor("conv-shell-jobless", false);
    const dir = await lineThrough(jobless, "cargo build", "call-3");
    writeFileSync(join(dir, "cmd"), "cargo build\n");
    expect(await jobless.settle("call-3", `--- command still running in tmux window run · output so far: ${dir}/out`, signal)).toBeUndefined();
    rmSync(dir, { recursive: true, force: true });
    await Promise.all([lines.dispose(), jobless.dispose()]);
});
