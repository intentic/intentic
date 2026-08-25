import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { type JsExecutionPlan, runJs } from "./js-runtime.js";

/* The RUNNER honouring a plan, real `node` subprocesses on purpose: the permission flags ARE the fence, and
 * only the real runtime can vouch for them. A mocked spawn would test our belief about Node, not Node. The
 * pure half (what plan a card yields, what argv a plan means) is js-runtime.test.ts. */

const NO_ABORT = new AbortController().signal;

const tree = (): string => {
    const dir = mkdtempSync(join(tmpdir(), "js-runtime-"));
    writeFileSync(join(dir, "a.txt"), "hello");
    return dir;
};

const planFor = (dir: string, overrides: Partial<JsExecutionPlan> = {}): JsExecutionPlan => ({
    cwd: dir,
    env: {},
    readRoots: [dir],
    writeRoots: [dir],
    allowSpawn: false,
    ...overrides,
});

const run = (plan: JsExecutionPlan, code: string, timeoutMs = 15_000) => runJs(plan, code, { timeoutMs, signal: NO_ABORT, placement: undefined });

test("a script runs as an ES module in the plan's cwd, top-level await and all", async () => {
    const dir = tree();
    const result = await run(planFor(dir), 'const fs = await import("node:fs/promises"); console.log(await fs.readFile("a.txt", "utf8"));');
    expect(result).toMatchObject({ exitCode: 0, timedOut: false, stderr: "" });
    expect(result.stdout.trim()).toBe("hello");
});

test("the fence is Node's own: a read outside the roots and a spawn are refused inside the process", async () => {
    const dir = tree();
    const result = await run(
        planFor(dir),
        `const fs = await import("node:fs/promises");
         await fs.readFile("/etc/hostname").then(() => console.log("read-ok"), (e) => console.log("read:" + e.code));
         const cp = await import("node:child_process");
         try { cp.execSync("echo hi"); console.log("spawn-ok"); } catch (e) { console.log("spawn:" + e.code); }`,
    );
    expect(result.stdout).toContain("read:ERR_ACCESS_DENIED");
    expect(result.stdout).toContain("spawn:ERR_ACCESS_DENIED");
    expect(result.exitCode).toBe(0);
});

test("a read-only plan refuses the write and allows the read", async () => {
    const dir = tree();
    const result = await run(
        planFor(dir, { writeRoots: [] }),
        `const fs = await import("node:fs/promises");
         console.log(await fs.readFile("a.txt", "utf8"));
         await fs.writeFile("b.txt", "x").then(() => console.log("write-ok"), (e) => console.log("write:" + e.code));`,
    );
    expect(result.stdout).toContain("hello");
    expect(result.stdout).toContain("write:ERR_ACCESS_DENIED");
});

test("a spawn-allowed plan starts programs, and its warning noise is kept out of stderr", async () => {
    const dir = tree();
    const result = await run(
        planFor(dir, { allowSpawn: true }),
        'const cp = await import("node:child_process"); console.log(cp.execSync("echo spawned").toString());',
    );
    expect(result.stdout).toContain("spawned");
    expect(result.stderr).not.toContain("SecurityWarning");
});

test("a script that throws reports its failure as an exit, not as a broken tool", async () => {
    const result = await run(planFor(tree()), 'throw new Error("deliberate");');
    expect(result.exitCode).not.toBe(0);
    expect(result.stderr).toContain("deliberate");
});

test("the plan's env rides into the process; the timeout kills a runaway", async () => {
    const dir = tree();
    const withEnv = await run(planFor(dir, { env: { JS_RUNTIME_PROBE: "42" } }), "console.log(process.env.JS_RUNTIME_PROBE);");
    expect(withEnv.stdout.trim()).toBe("42");
    const runaway = await run(planFor(dir), "await new Promise((resolve) => setTimeout(resolve, 60_000));", 500);
    expect(runaway).toMatchObject({ exitCode: undefined, timedOut: true });
});

test("aborting the turn kills the script the same way", async () => {
    const controller = new AbortController();
    const pending = runJs(planFor(tree()), "await new Promise((resolve) => setTimeout(resolve, 60_000));", {
        timeoutMs: 15_000,
        signal: controller.signal,
        placement: undefined,
    });
    setTimeout(() => controller.abort(), 100);
    const result = await pending;
    expect(result.exitCode).toBeUndefined();
    expect(result.timedOut).toBe(false);
});

/* The same Stop, arriving one tick earlier. A turn stopped while the command gate held this script's card
 * reaches the runner with the signal ALREADY aborted, and `addEventListener` on an aborted signal never fires:
 * the script used to run its full timeout (ten minutes at the ceiling) after the user stopped the turn. The
 * elapsed assertion is the whole point — a regression here still ends with `timedOut: true`, just much later. */
test("a turn stopped before the script was dispatched kills it immediately, not at the timeout", async () => {
    const controller = new AbortController();
    controller.abort();
    const startedAt = Date.now();
    const result = await runJs(planFor(tree()), "await new Promise((resolve) => setTimeout(resolve, 60_000));", {
        timeoutMs: 15_000,
        signal: controller.signal,
        placement: undefined,
    });
    expect(Date.now() - startedAt).toBeLessThan(10_000);
    expect(result.exitCode).toBeUndefined();
    expect(result.timedOut).toBe(false);
});
