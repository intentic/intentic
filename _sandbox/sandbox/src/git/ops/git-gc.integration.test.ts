import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { recordingLogger } from "../../harness/route-fakes.testing.js";
import { DAY_MS } from "../../system/chore-clock.js";
import { workspacePaths } from "../../workspace/workspace.js";
import { gcArgs, type GitGcDeps, gitGcChore, runGitGc } from "./git-gc.js";

const tempDirs: string[] = [];
afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

// A workspace root with one nested repo, as maintenance's suite has it: the pass must reach both.
const setup = async (): Promise<string> => {
    const work = await mkdtemp(join(tmpdir(), "intentic-gc-"));
    tempDirs.push(work);
    await mkdir(join(work, "intent"), { recursive: true });
    await writeFile(join(work, "intent", ".git"), "gitdir: /nonexistent/gits/intent\n");
    return work;
};

const deps = (
    work: string,
    over: Partial<GitGcDeps> = {},
): GitGcDeps & { readonly calls: { dir: string; args: readonly string[] }[]; readonly lines: Record<string, unknown>[] } => {
    const calls: { dir: string; args: readonly string[] }[] = [];
    const { lines, logger } = recordingLogger();
    return {
        workspace: workspacePaths(work),
        logger,
        conversations: { liveSessionIds: () => [] },
        gitRunning: async () => false,
        pollMs: 1,
        git: async (dir, args) => {
            calls.push({ dir, args });
            return { stdout: "", stderr: "" };
        },
        ...over,
        calls,
        lines,
    };
};

test("gc runs once per repo, through maintenance's lock, keeping unreachable objects two weeks, and logs how long", async () => {
    const work = await setup();
    const run = deps(work);
    await runGitGc(run);
    expect(gcArgs()).toEqual(["-c", "gc.pruneExpire=2.weeks.ago", "maintenance", "run", "--task=gc", "--quiet"]);
    expect(run.calls).toEqual([
        { dir: work, args: gcArgs() },
        { dir: join(work, "intent"), args: gcArgs() },
    ]);
    const ran = run.lines.filter((line) => line["message"] === "git gc: ran");
    expect(ran.map((line) => line["repo"])).toEqual(["root", "intent"]);
    expect(ran.every((line) => typeof line["ms"] === "number")).toBe(true);
});

test("a turn that starts stops the pass before the next repo", async () => {
    const work = await setup();
    const live: string[][] = [[], ["session-1"]];
    const run = deps(work, { conversations: { liveSessionIds: () => live.shift() ?? ["session-1"] } });
    await runGitGc(run);
    expect(run.calls.map((call) => call.dir)).toEqual([work]);
    expect(run.lines.find((line) => String(line["message"]).startsWith("git gc: a turn started"))).toMatchObject({ left: ["intent"] });
});

test("a repo waits for tomorrow while git keeps running, and runs when /proc cannot say", async () => {
    const work = await setup();
    const busy = deps(work, { gitRunning: async () => true });
    await runGitGc(busy);
    expect(busy.calls).toEqual([]);
    const unknown = deps(work, { gitRunning: async () => undefined });
    await runGitGc(unknown);
    expect(unknown.calls).toHaveLength(2);
});

test("a gc that fails costs only its own repo, and says so", async () => {
    const work = await setup();
    const run = deps(work, {
        git: async (dir) => {
            if (dir === work) {
                throw new Error("fatal: gc is already running on machine");
            }
            return { stdout: "", stderr: "" };
        },
    });
    await runGitGc(run);
    expect(run.lines.filter((line) => line["level"] === "warn").map((line) => [line["message"], line["repo"]])).toEqual([["git gc: failed", "root"]]);
    expect(run.lines.filter((line) => line["message"] === "git gc: ran").map((line) => line["repo"])).toEqual(["intent"]);
});

test("the chore is daily and held while a turn is live", async () => {
    let live: string[] = ["session-1"];
    const chore = gitGcChore(deps(await setup(), { conversations: { liveSessionIds: () => live } }));
    expect(chore).toMatchObject({ name: "git-gc", everyMs: DAY_MS });
    expect(chore.when?.()).toBe(false);
    live = [];
    expect(chore.when?.()).toBe(true);
});
