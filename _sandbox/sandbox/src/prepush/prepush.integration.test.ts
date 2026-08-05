import { execFile } from "node:child_process";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { SandboxSettingsSchema } from "@intentic/sandbox-contract";
import { expect, test, vi } from "vitest";
import type { Services } from "../composition.js";
import { unstubbed } from "@intentic/testing";
import type { TerminalRunner } from "../terminal/terminal-run.js";
import { PREPUSH_SESSION } from "../terminal/terminal-session.js";
import { createPrepushCheck } from "./prepush.js";

// The check touches sandboxSettings, workspace, logger and the terminal runner; `unstubbed` keeps the fake that
// small. Nothing is persisted — the run lives in the returned object, which is the whole point of the rewrite.
// The schema's own defaults with the two fields this check reads set on top — what the daemon actually hands
// `sandboxSettings.get`, rather than the two-key subset a cast used to let this fake pass off as the whole of it.
const SETTINGS = { ...SandboxSettingsSchema.parse({}), prepushCommand: "exit 0", prepushTimeoutMs: 60_000 };

const execFileAsync = promisify(execFile);

/* THE RUNNER SEAM. terminal-run.ts owns the shell, the tmux window and the kill — and bin/tmux-run.test.sh owns
 * proving that much works — so what is left under test here is the DECISIONS this module makes about a run. The
 * stand-in is therefore a real `bash -c` child holding the runner's contract exactly: a non-zero exit is a
 * RESULT, while an abort or a command that could not be started at all THROWS. It merges the two streams, because
 * what the real runner hands back is a capture of the PANE — and a suite's failure summary is as likely to arrive
 * on stderr as on stdout.
 *
 * The real runner is deliberately not used: it decides `visible` by looking for the image's tmux wrapper, so on a
 * machine that has one these tests would open real tmux sessions, and on a machine that hasn't they would cover
 * only the other half of the module. */
const fakeRunner = (visible: boolean, count: () => void): TerminalRunner =>
    unstubbed<TerminalRunner>("terminalRun", {
        visible,
        tryRun: async (_session, command, options) => {
            count();
            try {
                const { stdout, stderr } = await execFileAsync("bash", ["-c", command], {
                    cwd: options.cwd,
                    ...(options.signal !== undefined ? { signal: options.signal } : {}),
                });
                return { code: 0, output: stdout + stderr };
            } catch (cause) {
                const failure = cause as { code?: number | string; stdout?: string; stderr?: string };
                if (options.signal?.aborted === true || typeof failure.code !== "number") {
                    throw cause;
                }
                return { code: failure.code, output: (failure.stdout ?? "") + (failure.stderr ?? "") };
            }
        },
    });

interface Fakes {
    readonly services: Services;
    readonly settings: { current: typeof SETTINGS };
    // How many times the command has actually run — the "one suite at a time" assertion counts executions, not
    // results, because refusing a second run is precisely a claim about how often one was started.
    readonly runs: () => number;
}

// `visible` stands in for the sandbox having the tmux wrapper, and `root` for the working tree the check runs on —
// a `root` that does not exist is how the one genuinely unstartable command below is written.
const fakeServices = (over: Partial<typeof SETTINGS> & { visible?: boolean; root?: string } = {}): Fakes => {
    const { visible = true, root = mkdtempSync(join(tmpdir(), "prepush-")), ...fields } = over;
    const settings = { current: { ...SETTINGS, ...fields } };
    let runs = 0;
    const services = unstubbed<Services>("services", {
        workspace: unstubbed<Services["workspace"]>("workspace", { root }),
        sandboxSettings: unstubbed<Services["sandboxSettings"]>("sandboxSettings", { get: async () => settings.current }),
        logger: unstubbed<Services["logger"]>("logger", { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} }),
        terminalRun: fakeRunner(visible, () => {
            runs += 1;
        }),
    });
    return { services, settings, runs: () => runs };
};

/* REAL timers throughout — deliberately, and it is worth saying why rather than leaving the next person to
 * rediscover it. This drives a real child process, and faking timers around one splits the clock from the event
 * loop: `advanceTimersByTime` fast-forwards the watchdog but a spawned shell still exits on the real one, so the
 * fake-timer version of these tests raced its own children AND poisoned the tests after it. */
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/* THE RACE THE ROUTE'S `await` EXISTS FOR: the caller polls `state` the instant `run` resolves, so `run` must
 * not resolve before the run is visible. Resolving early handed that first poll an `idle`, which the push dialog
 * reads as "already settled" and closes itself over a check it never waited for. */
test("run resolves only once the run is visible to state", async () => {
    const { services } = fakeServices({ prepushCommand: "sleep 2; exit 0" });
    const check = createPrepushCheck(services);
    await check.run();
    expect((await check.state()).status).toBe("running");
});

/* THE OUTPUT IS THE TERMINAL'S. That first `state` is also what tells the browser WHERE to watch, so the session
 * has to be named from the start of the run and not merely at its end — a panel opening on the verdict would be a
 * terminal shown to a user who no longer needs one. Nothing accumulates here in the meantime: a dialog
 * re-printing a captured tail is exactly the surface this replaced. */
test("a running check names its terminal and carries no output of its own", async () => {
    const { services } = fakeServices({ prepushCommand: "echo working; sleep 2" });
    const check = createPrepushCheck(services);
    await check.run();
    const state = await check.state();
    expect(state.session).toBe(PREPUSH_SESSION);
    expect(state.output).toBe("");
});

// No tmux wrapper ⇒ the runner falls back to an invisible shell, so there is no tab to send anyone to. Naming one
// anyway would send the browser after a session that is never going to be listed.
test("a sandbox without the tmux wrapper names no terminal", async () => {
    const { services } = fakeServices({ prepushCommand: "exit 0", visible: false });
    const check = createPrepushCheck(services);
    await check.run();
    await vi.waitFor(async () => expect((await check.state()).status).toBe("passed"), { timeout: 5_000 });
    expect((await check.state()).session).toBeUndefined();
});

test("a zero exit is a passed result", async () => {
    const { services } = fakeServices({ prepushCommand: "echo all good; exit 0" });
    const check = createPrepushCheck(services);
    await check.run();
    await vi.waitFor(async () => expect((await check.state()).status).toBe("passed"), { timeout: 5_000 });
    expect((await check.state()).exitCode).toBe(0);
});

// The output a settled run keeps has ONE reader: the fix the dialog proposes when the suite goes red.
test("a non-zero exit is a failed result carrying the output", async () => {
    const { services } = fakeServices({ prepushCommand: "echo boom >&2; exit 3" });
    const check = createPrepushCheck(services);
    await check.run();
    await vi.waitFor(async () => expect((await check.state()).status).toBe("failed"), { timeout: 5_000 });
    const state = await check.state();
    expect(state.exitCode).toBe(3);
    // stderr counts: a suite's failure summary is as likely to arrive there as on stdout.
    expect(state.output).toContain("boom");
});

// The cap is what keeps a fix turn seeded from a red run about fixing rather than scrolling — the whole of the
// output is in the pane (and its log) for anyone who wants it.
test("the output a failure carries is capped to its tail", async () => {
    const { services } = fakeServices({ prepushCommand: "yes 0123456789 | head -n 5000; exit 1" });
    const check = createPrepushCheck(services);
    await check.run();
    await vi.waitFor(async () => expect((await check.state()).status).toBe("failed"), { timeout: 8_000 });
    const { output } = await check.state();
    expect(output.length).toBe(24_000);
    // The TAIL, so the last thing the command printed is the last thing the prompt shows.
    expect(output.endsWith("0123456789\n")).toBe(true);
}, 20_000);

// Two suites at once would fight over the same tree, the same ports and the same CPU — and the second would
// answer about a tree the first is still changing.
test("a second run while one is going starts nothing", async () => {
    const { services, runs } = fakeServices({ prepushCommand: "sleep 1; exit 0" });
    const check = createPrepushCheck(services);
    // Two in the SAME TICK, which is the case `running` alone cannot guard: reading the settings is an await, so
    // both calls would find no run in flight and start a suite each.
    await Promise.all([check.run(), check.run()]);
    await vi.waitFor(async () => expect((await check.state()).status).toBe("running"), { timeout: 5_000 });
    await check.run();
    await vi.waitFor(async () => expect((await check.state()).status).toBe("passed"), { timeout: 8_000 });
    expect(runs()).toBe(1);
}, 20_000);

/* The guard this module exists for: a check that outruns its ceiling must be LOUD, never a pass and never a
 * silent skip — and never filed as the user cancelling, which is the confusion the two flags exist to prevent.
 * Both kills are the same abort, so this module is the only thing that can say which of them happened. */
test("a check that outruns the timeout is failed and timedOut, never cancelled", async () => {
    // Below the schema's own 60s floor, which only guards what a user can type — the fake reads the field
    // directly, and a real ceiling would make this test take a minute to assert a branch that takes 150ms.
    const { services } = fakeServices({ prepushCommand: "sleep 30", prepushTimeoutMs: 150 });
    const check = createPrepushCheck(services);
    await check.run();
    await vi.waitFor(async () => expect((await check.state()).status).toBe("failed"), { timeout: 5_000 });
    expect((await check.state()).timedOut).toBe(true);
}, 20_000);

// A cancel must not read as a failure: nothing was learned about the code, and a "tests failed" dialog over a
// run the user stopped themselves would be the check lying about its own evidence.
test("a cancelled run is cancelled, not failed", async () => {
    const { services } = fakeServices({ prepushCommand: "sleep 30" });
    const check = createPrepushCheck(services);
    await check.run();
    await vi.waitFor(async () => expect((await check.state()).status).toBe("running"), { timeout: 5_000 });
    check.cancel();
    await vi.waitFor(async () => expect((await check.state()).status).toBe("cancelled"), { timeout: 8_000 });
}, 20_000);

// A command the shell cannot find is the shell's own 127 — a FAILED run whose output names the problem, which is
// what keeps it distinguishable from the `error` below.
test("a command the shell cannot find is a failure whose output says so", async () => {
    const { services } = fakeServices({ prepushCommand: "definitely-not-a-real-binary-xyz" });
    const check = createPrepushCheck(services);
    await check.run();
    await vi.waitFor(async () => expect((await check.state()).status).not.toBe("running"), { timeout: 5_000 });
    const state = await check.state();
    expect(state.status).toBe("failed");
    expect(state.output).toContain("not found");
});

/* An unstartable command is `error`, not `failed`, and the distinction is the whole reason the status exists: a
 * failed check means the code is broken and an agent can fix it, while this means the SETTING — or the tree it was
 * pointed at — is wrong. Seeding a fix turn from it would send an agent hunting a bug that isn't there. */
test("a command that could not be started at all is an error, not a failure", async () => {
    const { services } = fakeServices({ prepushCommand: "exit 0", root: "/definitely/not/a/directory" });
    const check = createPrepushCheck(services);
    await check.run();
    await vi.waitFor(async () => expect((await check.state()).status).not.toBe("running"), { timeout: 5_000 });
    const state = await check.state();
    expect(state.status).toBe("error");
    // It names the command, because what is broken is the thing the user typed rather than anything it ran.
    expect(state.output).toContain("exit 0");
});

// Clearing the command turns the check off, and a result from before that must not go on gating a push — the
// user would be answering a dialog about a check nobody can run any more.
test("clearing the command reports idle, whatever the last run concluded", async () => {
    const { services, settings } = fakeServices({ prepushCommand: "exit 1" });
    const check = createPrepushCheck(services);
    await check.run();
    await vi.waitFor(async () => expect((await check.state()).status).toBe("failed"), { timeout: 5_000 });
    settings.current = { ...settings.current, prepushCommand: "" };
    expect(await check.state()).toEqual({ status: "idle", command: "", output: "" });
});

// The same race from the other side: the setting was cleared between the click and the request reaching here.
test("run with no command configured starts nothing", async () => {
    const { services, runs } = fakeServices({ prepushCommand: "" });
    const check = createPrepushCheck(services);
    await check.run();
    await wait(100);
    expect(runs()).toBe(0);
    expect((await check.state()).status).toBe("idle");
});
