import { setTimeout as sleep } from "node:timers/promises";
import { HISTORY_ROOT, WORKSPACE_ROOT } from "@intentic/constants";
import type { Logger } from "pino";
import type { TerminalRunner } from "../terminal/terminal-run.js";
import { checkRunningIn } from "../workspace/deps/checks-in-flight.js";
import { type RuleCommandDeps, runRuleCommand } from "./rule-command.js";

// A rule's command is the daemon running a build on a tree. On the main tree that is the tree the review reads, so the
// window it opens is what keeps a build's emptied output dirs out of the owner's Changes list.

const ROOT = WORKSPACE_ROOT;

const deps = (tryRun: TerminalRunner["tryRun"]): RuleCommandDeps =>
    ({
        logger: { warn: () => undefined, info: () => undefined } as unknown as Logger,
        terminalRun: { tryRun },
        workspace: { root: ROOT },
    }) as unknown as RuleCommandDeps;

const request = (cwd: string): Parameters<typeof runRuleCommand>[1] => ({
    command: "pnpm run verify",
    timeoutMs: 10_000,
    cwd,
    session: "checks",
    window: "checks",
    outputBytes: 500,
});

// A fake runner's turn: `waitMs` queued in the session, then `runMs` of a command that dies with its signal.
const queuedThenRuns =
    (waitMs: number, runMs: number): TerminalRunner["tryRun"] =>
    async (_session, _command, options) => {
        await sleep(waitMs);
        options.onStarted?.();
        await sleep(runMs, undefined, options.signal === undefined ? {} : { signal: options.signal });
        return { code: 0, output: "" };
    };

test("a check on the main tree holds its repo's window open while it runs, not while it waits, and closes it on the way out", async () => {
    const during: boolean[] = [];
    const run = await runRuleCommand(
        deps(async (_session, _command, options) => {
            during.push(checkRunningIn("app"));
            options.onStarted?.();
            during.push(checkRunningIn("app"));
            return { code: 0, output: "" };
        }),
        request(`${ROOT}/app`),
    );
    expect(run.status).toBe("passed");
    expect(during).toEqual([false, true]);
    expect(checkRunningIn("app")).toBe(false);
});

// Every conversation's turn checks share one session; charging the wait behind the others to the ceiling killed checks
// that had barely started and told their agents the check itself had run out of time.
test("the ceiling counts the command's own run, never its wait in the session's queue", async () => {
    const run = await runRuleCommand(deps(queuedThenRuns(300, 50)), { ...request(`${ROOT}/app`), timeoutMs: 200 });
    expect(run.status).toBe("passed");
});

test("a command that outruns its ceiling once started is killed and reported as timed out", async () => {
    const run = await runRuleCommand(deps(queuedThenRuns(0, 5_000)), { ...request(`${ROOT}/app`), timeoutMs: 100 });
    expect(run).toEqual({ status: "failed", timedOut: true, output: "" });
    expect(checkRunningIn("app")).toBe(false);
});

test("a command that never ran closes the window too: a failure must not hide the repo's build outputs for good", async () => {
    const run = await runRuleCommand(
        deps(() => Promise.reject(new Error("no terminal"))),
        request(`${ROOT}/app`),
    );
    expect(run.status).toBe("error");
    expect(checkRunningIn("app")).toBe(false);
});

test("a command run outside the workspace opens no window: an isolated turn's worktree is reviewed against its branch", async () => {
    const during: boolean[] = [];
    await runRuleCommand(
        deps(async () => {
            during.push(checkRunningIn("app"));
            return { code: 0, output: "" };
        }),
        request(`${HISTORY_ROOT}/worktrees/glad-beacon/app`),
    );
    expect(during).toEqual([false]);
});
