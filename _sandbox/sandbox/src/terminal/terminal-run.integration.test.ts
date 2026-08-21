import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { createTerminalRunner, terminalExec } from "./terminal-run.js";
import { shellQuote } from "@intentic/sandbox-run/quote";

// These run the no-tmux fallback (the wrapper isn't baked into dev/test machines): plain bash -c with the
// same {code, output} contract the tmux path returns: the exact runner capability tests wire into their ctx.

test("tryRun returns output + the real exit code; run throws on non-zero with the tail in the message", async () => {
    const runner = createTerminalRunner();
    const cwd = mkdtempSync(join(tmpdir(), "term-run-"));
    expect(await runner.tryRun("job-test", "echo hi; exit 3", { cwd })).toEqual({ code: 3, output: "hi\n" });
    expect(await runner.run("job-test", "printf ok", { cwd })).toBe("ok");
    await expect(runner.run("job-test", "printf boom; exit 2", { cwd })).rejects.toThrow(/exited 2:\nboom/);
});

// The pane echoes the command line it is about to run, so a flow of quiet commands still looks like a terminal.
// That echo goes to the pane's tty, never to stdout: the caller's captured output is the command's alone, and
// an error tail (or an ACP agent's tool result) must not grow a copy of its own command line. Only bites where
// the tmux wrapper is baked in (the sandbox image); the fallback never writes the line at all.
test("the pane's echo of the command line stays out of the captured output", async () => {
    const runner = createTerminalRunner();
    expect(await runner.tryRun("job-echo", "printf ran", { cwd: tmpdir() })).toEqual({ code: 0, output: "ran" });
});

test("env pairs reach the command (the fallback's channel; the tmux path also rides them as -e flags)", async () => {
    const runner = createTerminalRunner();
    const { code, output } = await runner.tryRun("job-env", 'printf "%s" "$FOO"', { cwd: tmpdir(), env: { FOO: "bar" } });
    expect({ code, output }).toEqual({ code: 0, output: "bar" });
});

test("running() reports in-flight work per session; commands in one session run strictly in order", async () => {
    const runner = createTerminalRunner();
    const cwd = mkdtempSync(join(tmpdir(), "term-run-serial-"));
    const marks = join(cwd, "marks");
    const first = runner.tryRun("job-serial", `sleep 0.2; echo first >> ${shellQuote(marks)}`, { cwd });
    const second = runner.tryRun("job-serial", `echo second >> ${shellQuote(marks)}`, { cwd });
    expect(runner.running("job-serial")).toBe(true);
    expect(runner.running("job-other")).toBe(false);
    await Promise.all([first, second]);
    // Without the per-session queue the instant second command would win the race.
    expect(await readFile(marks, "utf8")).toBe("first\nsecond\n");
    expect(runner.running("job-serial")).toBe(false);
});

test("an aborted run rejects as an abort instead of returning a code", async () => {
    const runner = createTerminalRunner();
    const controller = new AbortController();
    const pending = runner.tryRun("job-abort", "sleep 5", { cwd: tmpdir(), signal: controller.signal });
    controller.abort();
    await expect(pending).rejects.toThrow();
    expect(runner.running("job-abort")).toBe(false);
});

test("terminalExec quotes argv into one command line and throws with the exit code attached", async () => {
    const exec = terminalExec(createTerminalRunner(), "job-exec", tmpdir());
    expect((await exec("printf", ["%s-%s", "a b", "c"])).stdout).toBe("a b-c");
    const failure = await exec("bash", ["-c", "exit 5"]).then(
        () => undefined,
        (error: Error & { code?: number }) => error,
    );
    expect(failure?.code).toBe(5);
});

test("shellQuote survives embedded single quotes", () => {
    expect(shellQuote("a'b")).toBe(`'a'\\''b'`);
});
