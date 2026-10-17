import type { GitRunner } from "@intentic/base/git";
import type { IndexRun, IndexRunHold } from "@intentic/sandbox-contract/schemas/git/index-run";
import { unstubbed } from "@intentic/testing";
import { waitFor } from "@intentic/testing/bun";
import type { Services } from "../../composition.js";
import { createIndexRuns, IndexRunBusy, type IndexRunDeps, type IndexRunSteps } from "./index-run.js";

// The run registry's lifecycle over fake steps: what it publishes while going, how it settles, who joins whom, and that a
// cancel reaches the git it is waiting on. Real git is index.routes.integration.test.ts's.

// A step held open until the test lets it go.
const gate = () => Promise.withResolvers<void>();

// A runner that never answers until its signal aborts, then rejects as killed git does: the cancel's only way out.
const hangingGit =
    (signal: AbortSignal): GitRunner =>
    () =>
        new Promise((_resolve, reject) => {
            signal.addEventListener("abort", () => reject(Object.assign(new Error("The operation was aborted"), { name: "AbortError" })));
        });

interface Harness {
    readonly deps: IndexRunDeps;
    // Every step call, in order, by name.
    readonly calls: string[];
    readonly invalidated: () => number;
}

const harness = (steps: Partial<IndexRunSteps> = {}, over: Partial<IndexRunDeps> = {}): Harness => {
    const calls: string[] = [];
    let invalidated = 0;
    const deps: IndexRunDeps = {
        logger: unstubbed<Services["logger"]>("logger", { info: () => {} }),
        perf: unstubbed<Services["perf"]>("perf", { track: (_op, _fields, run) => run() }),
        onRepo: (repo, task) => task(`/work/${repo}`),
        whileCommitting: (_repo, run) => run(),
        invalidate: () => {
            invalidated += 1;
        },
        steps: {
            count: async () => {
                calls.push("count");
                return ["a.ts", "b.ts"];
            },
            hold: async () => undefined,
            stage: async () => {
                calls.push("stage");
            },
            commit: async () => {
                calls.push("commit");
                return true;
            },
            answer: async (_repo, _dir, committed) => ({ committed }),
            ...steps,
        },
        ...over,
    };
    return { deps, calls, invalidated: () => invalidated };
};

const settled = (runs: { state: (repo: string) => IndexRun }, repo: string): Promise<IndexRun> =>
    waitFor(() => {
        const run = runs.state(repo);
        if (run.status === "running") {
            throw new Error(`still ${run.phase ?? "running"}`);
        }
        return run;
    });

test("a commit run answers at once, walks its phases under the lock, and settles with the commit's answer", async () => {
    const lock = gate();
    const staging = gate();
    const { deps, calls, invalidated } = harness(
        { stage: () => staging.promise },
        {
            onRepo: async (repo, task) => {
                await lock.promise;
                return task(`/work/${repo}`);
            },
        },
    );
    const runs = createIndexRuns(deps);
    const started = runs.start("app", { op: "commit", target: {}, message: "feat: all of it" });
    expect(started).toMatchObject({ status: "running", repo: "app", op: "commit", phase: "waiting", command: "git commit" });
    expect(started.id).not.toBe("");
    expect(runs.state("app")).toEqual(started);

    lock.resolve();
    await waitFor(() => expect(runs.state("app")).toMatchObject({ phase: "staging", files: { total: 2, done: 0 } }));
    staging.resolve();
    const verdict = await settled(runs, "app");
    expect(verdict).toMatchObject({ status: "passed", id: started.id, files: { total: 2, done: 2 }, result: { committed: true } });
    expect(verdict.phase).toBeUndefined();
    expect(verdict.finishedAt).toBeGreaterThanOrEqual(started.startedAt ?? 0);
    expect(calls).toEqual(["count", "commit"]);
    // Once after the stage, once after the commit: each moved the index.
    expect(invalidated()).toBe(2);
});

test("a plain commit (no target) neither counts nor stages, and a stage run never commits", async () => {
    const { deps, calls } = harness();
    const runs = createIndexRuns(deps);
    runs.start("app", { op: "commit", message: "fix: staged only" });
    expect(await settled(runs, "app")).toMatchObject({ status: "passed", result: { committed: true } });
    runs.start("lib", { op: "stage", target: {} });
    expect(await settled(runs, "lib")).toMatchObject({ status: "passed", op: "stage", command: "git add" });
    expect(calls).toEqual(["commit", "count", "stage"]);
});

test("the same request again while one runs joins it; a different one is refused, and nothing queues behind", async () => {
    const staging = gate();
    const { deps, calls } = harness({
        stage: async () => {
            calls.push("stage");
            await staging.promise;
        },
    });
    const runs = createIndexRuns(deps);
    const first = runs.start("app", { op: "stage", target: {} });
    const again = runs.start("app", { op: "stage", target: {} });
    expect(again.id).toBe(first.id);
    expect(() => runs.start("app", { op: "commit", target: {}, message: "feat: x" })).toThrow(IndexRunBusy);
    // Another repository has its own run.
    expect(runs.start("lib", { op: "stage", target: {} }).id).not.toBe(first.id);
    staging.resolve();
    await settled(runs, "app");
    await settled(runs, "lib");
    expect(calls.filter((call) => call === "stage")).toHaveLength(2);
    // Settled, the repo takes a new run with a new id.
    expect(runs.start("app", { op: "stage", target: {} }).id).not.toBe(first.id);
});

test("cancelling kills the git the run is waiting on, and the run settles as cancelled", async () => {
    let killed = false;
    const { deps } = harness(
        {
            stage: async (_repo, dir, _target, git) => {
                try {
                    await git(dir, ["add", "-A"]);
                } catch (error) {
                    killed = true;
                    throw error;
                }
            },
        },
        { gitFor: hangingGit },
    );
    const runs = createIndexRuns(deps);
    runs.start("app", { op: "commit", target: {}, message: "feat: never" });
    await waitFor(() => expect(runs.state("app").phase).toBe("staging"));
    runs.cancel("app");
    expect(await settled(runs, "app")).toMatchObject({ status: "cancelled" });
    expect(killed).toBe(true);
});

test("a run cancelled while queued behind the lock settles at once and never runs", async () => {
    const lock = gate();
    const { deps, calls } = harness(
        {},
        {
            onRepo: async (repo, task) => {
                await lock.promise;
                return task(`/work/${repo}`);
            },
        },
    );
    const runs = createIndexRuns(deps);
    const queued = runs.start("app", { op: "stage", target: {} });
    runs.cancel("app");
    expect(runs.state("app")).toMatchObject({ status: "cancelled", id: queued.id });
    // The lock frees later; the stale run must neither run nor overwrite a newer one.
    const next = runs.start("app", { op: "stage", target: { paths: ["a.ts"] } });
    lock.resolve();
    expect(await settled(runs, "app")).toMatchObject({ status: "passed", id: next.id });
    expect(calls).toEqual(["count", "stage"]);
});

test("a stage over the guardrail stops before staging and holds what it found, unless confirmed", async () => {
    const held: IndexRunHold = { files: 53_000, dirs: [{ dir: "venv", files: 52_900 }] };
    const { deps, calls } = harness({ hold: async () => held });
    const runs = createIndexRuns(deps);
    runs.start("app", { op: "commit", target: {}, message: "feat: deps" });
    expect(await settled(runs, "app")).toMatchObject({ status: "error", held, reason: expect.stringContaining("53000") });
    expect(calls).toEqual(["count"]);
    runs.start("app", { op: "commit", target: {}, message: "feat: deps", confirmed: true });
    expect(await settled(runs, "app")).toMatchObject({ status: "passed" });
    expect(calls).toEqual(["count", "count", "stage", "commit"]);
});

test("git's refusal settles the run as failed with git's words, and the scan is dropped all the same", async () => {
    const { deps, invalidated } = harness({
        commit: async () => {
            throw Object.assign(new Error("Command failed"), { stderr: "fatal: pre-commit hook refused\n" });
        },
    });
    const runs = createIndexRuns(deps);
    runs.start("app", { op: "commit", message: "feat: nope" });
    const verdict = await settled(runs, "app");
    expect(verdict.status).toBe("failed");
    expect(verdict.reason).toContain("pre-commit hook refused");
    expect(invalidated()).toBe(1);
});
