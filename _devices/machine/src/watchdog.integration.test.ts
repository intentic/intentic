import { spawn, spawnSync } from "node:child_process";
import { join } from "node:path";

/* The watchdog end to end, in a process of its own: a loop that hangs is killed from the Worker, after one line on
   stderr, and a loop that keeps answering is not. Run with this test runner's own binary, the one the agent compiles to. */

const script = (block: boolean): string => `
import { startWatchdog } from ${JSON.stringify(join(import.meta.dir, "watchdog.ts"))};
startWatchdog({ pingMs: 50, limitMs: 500 });
setTimeout(() => {
    if (${block}) { const end = Date.now() + 10_000; while (Date.now() < end) {} }
    process.stdout.write("survived\\n");
    process.exit(0);
}, ${block ? 100 : 1_500});
`;

const run = (block: boolean) => spawnSync(process.execPath, ["-e", script(block)], { encoding: "utf8", timeout: 20_000 });

test("a loop stuck past the limit is killed, after saying so", () => {
    const result = run(true);
    expect(result.signal).toBe("SIGKILL");
    expect(result.stdout).not.toContain("survived");
    expect(result.stderr).toMatch(/event loop stalled for \d+ s; exiting so the supervisor restarts the agent/);
});

test("a loop that keeps answering is left running, and the watchdog does not keep the process alive", () => {
    const result = run(false);
    expect({ status: result.status, stdout: result.stdout, stderr: result.stderr }).toEqual({ status: 0, stdout: "survived\n", stderr: "" });
});

// (2026-10-06) A process paused as a whole (a laptop asleep, a VM suspended, here SIGSTOP) wakes with the wall clock
// far past the last ping while its loop was never stuck: the Worker's first check after the pause must not read that
// as a hang. Three at once, since which thread's timer runs first after the pause is a race.
const pausable = `
import { startWatchdog } from ${JSON.stringify(join(import.meta.dir, "watchdog.ts"))};
startWatchdog({ pingMs: 200, limitMs: 1_000 });
process.stdout.write("ready\\n");
setTimeout(() => {
    process.stdout.write("survived\\n");
    process.exit(0);
}, 6_000);
`;

const pausedFor = async (ms: number): Promise<{ readonly signal: string | null; readonly stdout: string }> => {
    const child = spawn(process.execPath, ["-e", pausable], { stdio: ["ignore", "pipe", "pipe"] });
    let stdout = "";
    child.stdout.setEncoding("utf8");
    const ready = new Promise<void>((resolve) => {
        child.stdout.on("data", (chunk: string) => {
            stdout += chunk;
            if (stdout.includes("ready")) {
                resolve();
            }
        });
    });
    const ended = new Promise<string | null>((resolve) => child.on("exit", (_code, signal) => resolve(signal)));
    await ready;
    await new Promise((resolve) => setTimeout(resolve, 500));
    child.kill("SIGSTOP");
    await new Promise((resolve) => setTimeout(resolve, ms));
    child.kill("SIGCONT");
    const signal = await ended;
    return { signal, stdout };
};

test("a process paused for longer than the limit is not killed when it wakes", async () => {
    const runs = await Promise.all([pausedFor(2_500), pausedFor(2_500), pausedFor(2_500)]);
    expect(runs.map(({ signal, stdout }) => ({ signal, survived: stdout.includes("survived") }))).toEqual([
        { signal: null, survived: true },
        { signal: null, survived: true },
        { signal: null, survived: true },
    ]);
}, 20_000);
