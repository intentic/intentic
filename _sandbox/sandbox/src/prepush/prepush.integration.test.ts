import { execFile } from "node:child_process";
import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { REPO_CHECKS_FILE, type SandboxSettings, SandboxSettingsSchema } from "@intentic/sandbox-contract";
import { expect, test, vi } from "vitest";
import { SETTLES } from "@intentic/testing/vitest";
import type { Services } from "../composition.js";
import { unstubbed } from "@intentic/testing";
import type { TerminalRunner } from "../terminal/terminal-run.js";
import { CHECKS_SESSION } from "../terminal/terminal-session.js";
import { fingerprintOf } from "../rules/repo-checks.js";
import { createPrepushCheck } from "./prepush.js";

// Fixtures use `unstubbed` so the fake is only what a test touches; nothing persists. Tests state a command and
// timeout; rulesOf turns that into the rule table, layered onto the schema's real defaults.
const SETTINGS = SandboxSettingsSchema.parse({});

interface Knobs {
    readonly prepushCommand: string;
    readonly prepushTimeoutMs: number;
}

const DEFAULTS: Knobs = { prepushCommand: "exit 0", prepushTimeoutMs: 60_000 };

// An empty command means off; off is an empty rule table, the same as clearing the settings row.
const rulesOf = ({ prepushCommand, prepushTimeoutMs }: Knobs): SandboxSettings["rules"] =>
    prepushCommand === ""
        ? []
        : [
              {
                  id: "pre-push",
                  label: "Check before you push",
                  moment: "push.starting",
                  action: { kind: "command", command: prepushCommand, timeoutMs: prepushTimeoutMs },
                  enabled: true,
              },
          ];

const execFileAsync = promisify(execFile);

// A real `bash -c` child matching the runner's contract: non-zero exit is a result; an abort or unstartable command
// throws. Not the real runner, whose `visible` depends on the machine having a tmux wrapper.
const fakeRunner = (visible: boolean, count: () => void, starts = true): TerminalRunner =>
    unstubbed<TerminalRunner>("terminalRun", {
        visible,
        tryRun: async (_session, command, options) => {
            count();
            // onStarted fires once the tmux window exists; `starts: false` means queued but not yet in a terminal.
            if (starts) {
                options.onStarted?.();
            }
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
    readonly settings: { current: SandboxSettings };
    // Every away-notification the check sent; asserting which runs send one is the point of this subsystem.
    readonly notified: () => readonly string[];
    // Executions, not results; the one-suite-at-a-time claim is about how often a run started.
    readonly runs: () => number;
}

// `visible` stands in for the tmux wrapper; `root` for the working tree, and a missing one is how the
// unstartable-command test is written.
const fakeServices = (over: Partial<Knobs> & { visible?: boolean; root?: string; starts?: boolean } = {}): Fakes => {
    const { visible = true, starts = true, root = mkdtempSync(join(tmpdir(), "prepush-")), ...knobs } = over;
    const settings = { current: { ...SETTINGS, rules: rulesOf({ ...DEFAULTS, ...knobs }) } };
    let runs = 0;
    const notified: string[] = [];
    const services = unstubbed<Services>("services", {
        workspace: unstubbed<Services["workspace"]>("workspace", { root }),
        sandboxSettings: unstubbed<Services["sandboxSettings"]>("sandboxSettings", { get: async () => settings.current }),
        logger: unstubbed<Services["logger"]>("logger", { info: () => {}, warn: () => {}, debug: () => {}, error: () => {} }),
        pushSender: unstubbed<Services["pushSender"]>("pushSender", {
            notifyIfAway: async (notification) => {
                notified.push(notification.title);
                return { delivered: 1, failed: 0 };
            },
        }),
        terminalRun: fakeRunner(
            visible,
            () => {
                runs += 1;
            },
            starts,
        ),
        // Fire-and-forget bookkeeping the check must never block on; the fakes only need to exist.
        ruleFirings: unstubbed<Services["ruleFirings"]>("ruleFirings", { stamp: async () => {} }),
        activity: unstubbed<Services["activity"]>("activity", { append: async () => {} }),
    });
    return { services, settings, runs: () => runs, notified: () => notified };
};

// Real timers throughout: this drives a real child process, and faking them would split the clock from the event loop
// the child actually runs on.
const wait = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

// The caller polls `state` the instant `run` resolves; resolving early would hand it a stale `idle`, and the push
// dialog would treat the check as already settled.
test("run resolves only once the run is visible to state", async () => {
    const { services } = fakeServices({ prepushCommand: "sleep 2; exit 0" });
    const check = createPrepushCheck(services);
    await check.run();
    expect((await check.state()).status).toBe("running");
});

// `state` also tells the browser where to watch; a running check names its session but accumulates no output.
test("a running check names its terminal and carries no output of its own", async () => {
    const { services } = fakeServices({ prepushCommand: "echo working; sleep 2" });
    const check = createPrepushCheck(services);
    await check.run();
    // Polled, not read once: a memory gate delays the spawn, so the terminal name lags visibility by a beat.
    await vi.waitFor(async () => expect((await check.state()).session).toBe(CHECKS_SESSION), SETTLES);
    expect((await check.state()).output).toBe("");
});

// `session` is an instruction: naming one opens the app's terminal panel on it immediately. Naming a session before its
// tmux window exists would open an empty panel.
test("a check that has not reached its terminal yet names none", async () => {
    const { services } = fakeServices({ prepushCommand: "sleep 2", starts: false });
    const check = createPrepushCheck(services);
    await check.run();
    const state = await check.state();
    expect(state.status).toBe("running");
    expect(state.session).toBeUndefined();
});

// No tmux wrapper means an invisible shell; naming a session would send the browser somewhere never listed.
test("a sandbox without the tmux wrapper names no terminal", async () => {
    const { services } = fakeServices({ prepushCommand: "exit 0", visible: false });
    const check = createPrepushCheck(services);
    await check.run();
    await vi.waitFor(async () => expect((await check.state()).status).toBe("passed"), SETTLES);
    expect((await check.state()).session).toBeUndefined();
});

test("a zero exit is a passed result", async () => {
    const { services } = fakeServices({ prepushCommand: "echo all good; exit 0" });
    const check = createPrepushCheck(services);
    await check.run();
    await vi.waitFor(async () => expect((await check.state()).status).toBe("passed"), SETTLES);
    expect((await check.state()).exitCode).toBe(0);
});

// The output a settled run keeps has one reader: the fix-turn prompt the dialog proposes on red.
test("a non-zero exit is a failed result carrying the output", async () => {
    const { services } = fakeServices({ prepushCommand: "echo boom >&2; exit 3" });
    const check = createPrepushCheck(services);
    await check.run();
    await vi.waitFor(async () => expect((await check.state()).status).toBe("failed"), SETTLES);
    const state = await check.state();
    expect(state.exitCode).toBe(3);
    // stderr counts: a suite's failure summary is as likely to arrive there as on stdout.
    expect(state.output).toContain("boom");
});

// The output's one reader is a prompt a model reads; raw escape codes (`[2m`) would litter it, so what's kept is what
// the screen showed, not the terminal's own bytes.
test("the output a failure carries is plain text, not the terminal's own bytes", async () => {
    const { services } = fakeServices({ prepushCommand: String.raw`printf '\033[31mboom\033[0m\n1/2\r2/2 done\n'; exit 1` });
    const check = createPrepushCheck(services);
    await check.run();
    await vi.waitFor(async () => expect((await check.state()).status).toBe("failed"), SETTLES);
    const { output } = await check.state();
    expect(output).toBe("boom\n2/2 done\n");
});

// The cap keeps a fix turn about fixing, not scrolling; the full output stays in the pane and its log.
test("the output a failure carries is capped to its tail", async () => {
    const { services } = fakeServices({ prepushCommand: "yes 0123456789 | head -n 5000; exit 1" });
    const check = createPrepushCheck(services);
    await check.run();
    await vi.waitFor(async () => expect((await check.state()).status).toBe("failed"), SETTLES);
    const { output } = await check.state();
    expect(output.length).toBe(24_000);
    // The tail: the last thing the command printed is the last thing the prompt shows.
    expect(output.endsWith("0123456789\n")).toBe(true);
});

// Two suites at once would fight over the same tree, ports, and CPU.
test("a second run while one is going starts nothing", async () => {
    const { services, runs } = fakeServices({ prepushCommand: "sleep 1; exit 0" });
    const check = createPrepushCheck(services);
    // Same-tick calls both see no run in flight (reading settings awaits), so `running` alone can't guard this.
    await Promise.all([check.run(), check.run()]);
    await vi.waitFor(async () => expect((await check.state()).status).toBe("running"), SETTLES);
    await check.run();
    await vi.waitFor(async () => expect((await check.state()).status).toBe("passed"), SETTLES);
    expect(runs()).toBe(1);
});

// Both a timeout and a cancel kill the same abort; only this module knows which happened, so it must say so rather than
// reading either as the other.
test("a check that outruns the timeout is failed and timedOut, never cancelled", async () => {
    // Below the schema's 60s floor (that only bounds user input); the fake reads the field directly.
    const { services } = fakeServices({ prepushCommand: "sleep 30", prepushTimeoutMs: 150 });
    const check = createPrepushCheck(services);
    await check.run();
    await vi.waitFor(async () => expect((await check.state()).status).toBe("failed"), SETTLES);
    expect((await check.state()).timedOut).toBe(true);
});

// A cancel isn't a failure: nothing was learned about the code the user chose to stop.
test("a cancelled run is cancelled, not failed", async () => {
    const { services } = fakeServices({ prepushCommand: "sleep 30" });
    const check = createPrepushCheck(services);
    await check.run();
    await vi.waitFor(async () => expect((await check.state()).status).toBe("running"), SETTLES);
    check.cancel();
    await vi.waitFor(async () => expect((await check.state()).status).toBe("cancelled"), SETTLES);
});

// Only outcomes that leave the push unsent are worth interrupting for; a pass just goes through, and a cancel was the
// user's own hand.
test("a red verdict notifies devices; a pass and a cancel say nothing", async () => {
    const red = fakeServices({ prepushCommand: "exit 1" });
    const redCheck = createPrepushCheck(red.services);
    await redCheck.run();
    await vi.waitFor(async () => expect((await redCheck.state()).status).toBe("failed"), SETTLES);
    expect(red.notified()).toEqual(["Checks failed"]);

    const green = fakeServices({ prepushCommand: "exit 0" });
    const greenCheck = createPrepushCheck(green.services);
    await greenCheck.run();
    await vi.waitFor(async () => expect((await greenCheck.state()).status).toBe("passed"), SETTLES);
    expect(green.notified()).toEqual([]);

    const stopped = fakeServices({ prepushCommand: "sleep 30" });
    const stoppedCheck = createPrepushCheck(stopped.services);
    await stoppedCheck.run();
    await vi.waitFor(async () => expect((await stoppedCheck.state()).status).toBe("running"), SETTLES);
    stoppedCheck.cancel();
    await vi.waitFor(async () => expect((await stoppedCheck.state()).status).toBe("cancelled"), SETTLES);
    expect(stopped.notified()).toEqual([]);
});

// A timeout must say so, not 'failed', or the user goes hunting a test that never ran.
test("a timed-out check notifies as a timeout", async () => {
    const { services, notified } = fakeServices({ prepushCommand: "sleep 30", prepushTimeoutMs: 150 });
    const check = createPrepushCheck(services);
    await check.run();
    await vi.waitFor(async () => expect((await check.state()).status).toBe("failed"), SETTLES);
    expect(notified()).toEqual(["Checks timed out"]);
});

// A command the shell can't find is the shell's own 127: a failed run, distinct from the `error` case below.
test("a command the shell cannot find is a failure whose output says so", async () => {
    const { services } = fakeServices({ prepushCommand: "definitely-not-a-real-binary-xyz" });
    const check = createPrepushCheck(services);
    await check.run();
    await vi.waitFor(async () => expect((await check.state()).status).not.toBe("running"), SETTLES);
    const state = await check.state();
    expect(state.status).toBe("failed");
    expect(state.output).toContain("not found");
});

// `failed` means the code is broken and fixable; `error` means the setting or tree is wrong, so seeding a fix turn from
// it would send an agent hunting a bug that isn't there.
test("a command that could not be started at all is an error, not a failure", async () => {
    const { services } = fakeServices({ prepushCommand: "exit 0", root: "/definitely/not/a/directory" });
    const check = createPrepushCheck(services);
    await check.run();
    await vi.waitFor(async () => expect((await check.state()).status).not.toBe("running"), SETTLES);
    const state = await check.state();
    expect(state.status).toBe("error");
    // Names the command: what's broken is what the user typed, not anything it ran.
    expect(state.output).toContain("exit 0");
});

// Clearing the command turns the check off; a stale result must not keep gating a push.
test("clearing the command reports idle, whatever the last run concluded", async () => {
    const { services, settings } = fakeServices({ prepushCommand: "exit 1" });
    const check = createPrepushCheck(services);
    await check.run();
    await vi.waitFor(async () => expect((await check.state()).status).toBe("failed"), SETTLES);
    settings.current = { ...settings.current, rules: [] };
    expect(await check.state()).toEqual({ status: "idle", command: "", output: "" });
});

// The setting was cleared between the click and the request reaching here.
test("run with no command configured starts nothing", async () => {
    const { services, runs } = fakeServices({ prepushCommand: "" });
    const check = createPrepushCheck(services);
    await check.run();
    await wait(100);
    expect(runs()).toBe(0);
    expect((await check.state()).status).toBe("idle");
});

/* WHAT A REPOSITORY ASKS FOR ITSELF, at the one moment it matters: a push. Three facts, each of which was untrue while
 * one command in the settings stood for every repository in the workspace — it ran for pushes it had nothing to do
 * with, it ran from the workspace root, and it could not be written by the repository that owns the build. */

// A workspace with one repository that declares a check of its own; the marker file is how a test proves WHERE a
// command ran, since a `cd` in the wrong place is the failure this whole change is about.
const workspaceDeclaring = (repo: string, checks: { when: "turn" | "push"; run: string }[]): { root: string; fingerprint: string } => {
    const root = mkdtempSync(join(tmpdir(), "prepush-repo-"));
    mkdirSync(join(root, repo, ".git"), { recursive: true });
    const declaration = join(root, repo, REPO_CHECKS_FILE);
    mkdirSync(dirname(declaration), { recursive: true });
    writeFileSync(declaration, JSON.stringify({ checks }));
    // Exists only inside the repository, so a command that finds it was run there and not at the workspace root.
    writeFileSync(join(root, repo, "in-this-repo"), "");
    return { root, fingerprint: fingerprintOf(checks) };
};

test("a repository's own check runs when that repository is pushed, in its own directory", async () => {
    const { root, fingerprint } = workspaceDeclaring("app", [{ when: "push", run: "test -f in-this-repo" }]);
    const { services, settings } = fakeServices({ root, prepushCommand: "" });
    settings.current = { ...settings.current, adoptedChecks: { app: fingerprint } };
    const check = createPrepushCheck(services);
    await check.run(["app"]);
    await vi.waitFor(async () => expect((await check.state()).status).toBe("passed"), SETTLES);
});

// The failure the old single command could not avoid: pushing the docs repo ran the app's suite.
test("it does not run when a different repository is the one going out", async () => {
    const { root, fingerprint } = workspaceDeclaring("app", [{ when: "push", run: "test -f in-this-repo" }]);
    const { services, settings, runs } = fakeServices({ root, prepushCommand: "" });
    settings.current = { ...settings.current, adoptedChecks: { app: fingerprint } };
    const check = createPrepushCheck(services);
    await check.run(["docs"]);
    await wait(100);
    expect(runs()).toBe(0);
    expect((await check.state()).status).toBe("idle");
});

// The gate itself: a file in a repository is a command somebody else may have written.
test("a declaration nobody has adopted runs nothing at all", async () => {
    const { root } = workspaceDeclaring("app", [{ when: "push", run: "test -f in-this-repo" }]);
    const { services, runs } = fakeServices({ root, prepushCommand: "" });
    const check = createPrepushCheck(services);
    await check.run(["app"]);
    await wait(100);
    expect(runs()).toBe(0);
});

// The same directory rule for a rule the OWNER wrote and aimed at a repository, so neither has to spell a `cd`.
test("an owner's rule naming a repository also runs inside it", async () => {
    const { root } = workspaceDeclaring("app", []);
    const { services, settings } = fakeServices({ root, prepushCommand: "" });
    settings.current = {
        ...settings.current,
        rules: [
            {
                id: "app-check",
                label: "App check",
                moment: "push.starting",
                when: { repo: "app" },
                action: { kind: "command", command: "test -f in-this-repo", timeoutMs: 60_000 },
                enabled: true,
            },
        ],
    };
    const check = createPrepushCheck(services);
    await check.run(["app"]);
    await vi.waitFor(async () => expect((await check.state()).status).toBe("passed"), SETTLES);
});
