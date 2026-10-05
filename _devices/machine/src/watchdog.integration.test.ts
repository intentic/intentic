import { spawnSync } from "node:child_process";
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
