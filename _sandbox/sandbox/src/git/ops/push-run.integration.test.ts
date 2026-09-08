import { execFile } from "node:child_process";
import { chmod, mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { PushRun } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import { SETTLES } from "@intentic/testing/vitest";
import { afterEach, expect, test, vi } from "vitest";
import type { Services } from "../../composition.js";
import type { TerminalRunner } from "../../terminal/terminal-run.js";
import { CHECKS_SESSION } from "../../terminal/terminal-session.js";
import { createPushRuns, type PushRunDeps } from "./push-run.js";

// Real git and hooks, a fake terminal (the real one would open actual tmux sessions): tests what this module decides
// about visibility, settlement and refusal, with all three refusal kinds produced by real git.

const exec = promisify(execFile);
const sh = async (cwd: string, ...args: string[]): Promise<string> => (await exec("git", ["-C", cwd, ...args])).stdout.trim();

const tempDirs: string[] = [];
afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

const temp = async (): Promise<string> => {
    const dir = await mkdtemp(join(tmpdir(), "intentic-push-run-"));
    tempDirs.push(dir);
    return dir;
};

const commit = async (dir: string, name: string, body: string): Promise<void> => {
    await writeFile(join(dir, name), `${body}\n`);
    await sh(dir, "add", "-A");
    await sh(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", body);
};

// A clone one commit ahead of a real (local, bare) origin: a push that has something to send.
const ahead = async (): Promise<{ clone: string; origin: string }> => {
    const source = await temp();
    await sh(source, "init", "-q", "-b", "main");
    await commit(source, "a.txt", "one");
    const origin = await temp();
    await exec("git", ["clone", "-q", "--bare", source, origin]);
    const clone = await temp();
    await exec("git", ["clone", "-q", origin, clone]);
    await sh(clone, "config", "user.name", "t");
    await sh(clone, "config", "user.email", "t@t");
    await commit(clone, "b.txt", "two");
    return { clone, origin };
};

// A real pre-push hook; its stdout/stderr go to the pane, its exit code is git's answer.
const hook = async (clone: string, script: string): Promise<void> => {
    const path = join(clone, ".git", "hooks", "pre-push");
    await mkdir(join(clone, ".git", "hooks"), { recursive: true });
    await writeFile(path, `#!/bin/sh\n${script}\n`);
    await chmod(path, 0o755);
};

const fakeRunner = (visible: boolean, count: () => void, starts = true): TerminalRunner =>
    unstubbed<TerminalRunner>("terminalRun", {
        visible,
        tryRun: async (_session, command, options) => {
            count();
            if (starts) {
                options.onStarted?.();
            }
            try {
                const { stdout, stderr } = await exec("bash", ["-c", command], {
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
    readonly services: PushRunDeps;
    // Every away-notification sent, by title: which runs interrupt the owner is worth asserting.
    readonly notified: () => readonly string[];
    // Every feed row appended, by type.
    readonly feed: () => readonly string[];
    // How many commands actually ran, the "one push at a time" claim counts executions.
    readonly runs: () => number;
}

const fakes = (over: { visible?: boolean; starts?: boolean } = {}): Fakes => {
    const { visible = true, starts = true } = over;
    let runs = 0;
    const notified: string[] = [];
    const feed: string[] = [];
    const services = unstubbed<Services>("services", {
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
        activity: unstubbed<Services["activity"]>("activity", {
            append: async (event) => {
                feed.push(event.type);
            },
        }),
    });
    return { services, notified: () => notified, feed: () => feed, runs: () => runs };
};

const settled = async (runs: ReturnType<typeof createPushRuns>, repo: string): Promise<PushRun> => {
    await vi.waitFor(() => expect(runs.state(repo).status).not.toBe("running"), SETTLES);
    return runs.state(repo);
};

// Guards the race the route's `await` exists for: `start` must not resolve before the run is visible to `state`, or the
// first poll reads `idle` as already settled.
test("start resolves only once the run is visible to state, naming the command git will run", async () => {
    const { clone } = await ahead();
    await hook(clone, "sleep 1");
    const { services } = fakes();
    const runs = createPushRuns(services, () => {});
    await runs.start("app", clone, {});
    expect(runs.state("app")).toMatchObject({ status: "running", repo: "app", command: "git push origin main", output: "" });
    await settled(runs, "app");
});

test("a running push names its terminal once the command is in it, and none without the tmux wrapper", async () => {
    const { clone } = await ahead();
    await hook(clone, "sleep 1");
    const visible = fakes();
    const runs = createPushRuns(visible.services, () => {});
    await runs.start("app", clone, {});
    await vi.waitFor(() => expect(runs.state("app").session).toBe(CHECKS_SESSION), SETTLES);
    await settled(runs, "app");

    const { clone: other } = await ahead();
    await hook(other, "sleep 1");
    const invisible = fakes({ visible: false });
    const hidden = createPushRuns(invisible.services, () => {});
    await hidden.start("app", other, {});
    expect(hidden.state("app").status).toBe("running");
    const done = await settled(hidden, "app");
    expect(done.session).toBeUndefined();
});

test("a push that goes is passed, reports the repo pushed, and interrupts nobody", async () => {
    const { clone, origin } = await ahead();
    const { services, notified, feed } = fakes();
    const pushed: string[] = [];
    const runs = createPushRuns(services, (repo) => pushed.push(repo));
    await runs.start("app", clone, {});
    const run = await settled(runs, "app");
    expect(run).toMatchObject({ status: "passed", exitCode: 0, repo: "app" });
    expect(run.reason).toBeUndefined();
    expect(run.refusedBy).toBeUndefined();
    expect(pushed).toEqual(["app"]);
    expect(notified()).toEqual([]);
    expect(feed()).toEqual([]);
    expect(await sh(origin, "log", "--format=%s", "-1", "main")).toBe("two");
});

// Of the three refusal kinds, only the hook is something an agent can fix; the other two are the owner's.
test("a pre-push hook that says no settles as failed, refused by the hook, with the hook's words in the tail", async () => {
    const { clone, origin } = await ahead();
    await hook(clone, 'echo "verify-push: typecheck failed; the push does not go" >&2; exit 1');
    const { services, notified, feed } = fakes();
    const runs = createPushRuns(services, () => {});
    await runs.start("app", clone, {});
    const run = await settled(runs, "app");
    expect(run).toMatchObject({ status: "failed", exitCode: 1, refusedBy: "hook", reason: `error: failed to push some refs to '${origin}'` });
    expect(run.output).toContain("verify-push: typecheck failed; the push does not go");
    expect(notified()).toEqual(["Push failed"]);
    expect(feed()).toEqual(["git.push_refused"]);
    expect(await sh(origin, "log", "--format=%s", "-1", "main")).toBe("one");
});

test("an origin that has moved on settles as refused by the remote", async () => {
    const { clone, origin } = await ahead();
    // Somebody else's commit lands on the origin first, so the clone's main no longer fast-forwards.
    const other = await temp();
    await exec("git", ["clone", "-q", origin, other]);
    await sh(other, "config", "user.name", "t");
    await sh(other, "config", "user.email", "t@t");
    await commit(other, "c.txt", "three");
    await sh(other, "push", "-q", "origin", "main");

    const { services } = fakes();
    const runs = createPushRuns(services, () => {});
    await runs.start("app", clone, {});
    const run = await settled(runs, "app");
    // The ref status line names why, in brackets; git's plain verdict below it only says some refs failed.
    expect(run).toMatchObject({ status: "failed", exitCode: 1, refusedBy: "remote", reason: "! [rejected] main -> main (fetch first)" });
});

test("a remote that is not a repository settles as refused by the transport", async () => {
    const { clone } = await ahead();
    const nowhere = join(await temp(), "does-not-exist.git");
    await sh(clone, "remote", "set-url", "origin", nowhere);
    const { services } = fakes();
    const runs = createPushRuns(services, () => {});
    await runs.start("app", clone, {});
    const run = await settled(runs, "app");
    expect(run).toMatchObject({ status: "failed", exitCode: 128, refusedBy: "transport", reason: "fatal: Could not read from remote repository." });
});

test("a repo with no remote is an error that ran nothing, with the situation as its reason", async () => {
    const lonely = await temp();
    await sh(lonely, "init", "-q", "-b", "main");
    await commit(lonely, "a.txt", "one");
    const { services, runs: count, notified } = fakes();
    const runs = createPushRuns(services, () => {});
    await runs.start("app", lonely, {});
    expect(runs.state("app")).toMatchObject({ status: "error", repo: "app", reason: "no remote configured", output: "" });
    expect(count()).toBe(0);
    // Still notified even though nothing ran: the owner asked for a push that went nowhere.
    expect(notified()).toEqual(["Push couldn't run"]);
});

test("a second start for a repo already going starts nothing", async () => {
    const { clone } = await ahead();
    await hook(clone, "sleep 1");
    const { services, runs: count } = fakes();
    const runs = createPushRuns(services, () => {});
    await runs.start("app", clone, {});
    await runs.start("app", clone, {});
    await settled(runs, "app");
    expect(count()).toBe(1);
});

test("two repos take turns in the one terminal window", async () => {
    const first = await ahead();
    const second = await ahead();
    await hook(first.clone, "sleep 1");
    const { services } = fakes();
    const runs = createPushRuns(services, () => {});
    await runs.start("one", first.clone, {});
    await runs.start("two", second.clone, {});
    // The second push is queued behind the first and has no session until it actually starts.
    await vi.waitFor(() => expect(runs.state("one").session).toBe(CHECKS_SESSION), SETTLES);
    expect(runs.state("two")).toMatchObject({ status: "running" });
    expect(runs.state("two").session).toBeUndefined();
    const one = await settled(runs, "one");
    const two = await settled(runs, "two");
    expect(one.status).toBe("passed");
    expect(two.status).toBe("passed");
    expect(two.session).toBe(CHECKS_SESSION);
});

test("a cancelled push is cancelled, not failed, and nobody is notified", async () => {
    const { clone, origin } = await ahead();
    await hook(clone, "sleep 30");
    const { services, notified } = fakes();
    const runs = createPushRuns(services, () => {});
    await runs.start("app", clone, {});
    await vi.waitFor(() => expect(runs.state("app").session).toBe(CHECKS_SESSION), SETTLES);
    runs.cancel("app");
    const run = await settled(runs, "app");
    expect(run.status).toBe("cancelled");
    expect(run.refusedBy).toBeUndefined();
    expect(notified()).toEqual([]);
    expect(await sh(origin, "log", "--format=%s", "-1", "main")).toBe("one");
});

test("a push that outruns its ceiling is failed and timedOut, with no refusal to read", async () => {
    const { clone } = await ahead();
    await hook(clone, "sleep 30");
    const { services, notified } = fakes();
    const runs = createPushRuns(services, () => {}, undefined, { timeoutMs: 500 });
    await runs.start("app", clone, {});
    const run = await settled(runs, "app");
    expect(run).toMatchObject({ status: "failed", timedOut: true });
    expect(run.refusedBy).toBeUndefined();
    expect(run.reason).toBeUndefined();
    expect(notified()).toEqual(["Push timed out"]);
});

test("a repo nothing has been started for is idle", () => {
    const { services } = fakes();
    const runs = createPushRuns(services, () => {});
    expect(runs.state("app")).toEqual({ status: "idle", repo: "app", command: "", output: "" });
});
