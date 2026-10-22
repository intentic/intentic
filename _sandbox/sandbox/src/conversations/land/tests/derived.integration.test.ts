import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { defaultGit } from "@intentic/base/git";
import { unstubbed } from "@intentic/testing";
import { SETTLES, waitFor } from "@intentic/testing/bun";
import { createApp } from "../../../app.js";
import type { CompositionCore } from "../../../composition.js";
import { gitSlice } from "../../../git/git-slice.js";
import { clientFor } from "../../../harness/route-client.testing.js";
import { services } from "../../../harness/route-services.testing.js";
import { isolatedAgent } from "../../registry/agents-store.testing.js";
import type { AgentsRegistry } from "../../registry/agents-registry.js";
import { createExpiryTracker } from "../../registry/expiry.js";
import { noIsolation } from "../../worktrees/isolation.testing.js";
import { createAgentWorktrees, type AgentWorktrees } from "../../worktrees/worktrees.js";
import { ensureRootRepo } from "../../../git/remote/root-repo.js";
import { createLogger } from "../../../logger.js";
import { createPerfTracker } from "../../../system/resources/perf.js";
import { workspacePaths } from "../../../workspace/workspace.js";
import { presenceOf } from "../agent-changes.js";
import { landAgent } from "../land.js";
import { createAgentOrigins } from "../origins.js";
import { afterLand, REPO_FIXERS, rederiveSettled, scheduleRederive, withRederivedRepo } from "../rederive.js";
import { syncConversation } from "../sync.js";

// A file the repository marks `merge=derived` is a function of the tree it sits in. The evidence this pins: in two weeks
// of October, 21 lands were refused on intentic's contract.lock.json alone, each a pair of conversations that had both
// moved the contract, and five of main's CI runs failed on a lock nobody had written again. Here `derived.txt` is every
// file of `src/` in name order, and the repository's own fixers (a stand-in for _tools/scripts/verify/fixers.mjs) write
// it. Two lines next to each other, so two conversations that each moved one of them cannot both apply as text. The
// land itself is a git operation only: the writers run after it, in the background (afterLand), and the tests wait for
// them with rederiveSettled, as a version commit does.

const exec = promisify(execFile);
const sh = async (cwd: string, ...args: string[]): Promise<string> => (await exec("git", ["-C", cwd, ...args])).stdout.trim();
const commit = (cwd: string, message: string): Promise<string> => sh(cwd, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-am", message);
const logger = createLogger({ logLevel: "silent", logPretty: false, historyRoot: "" });
const perf = createPerfTracker(logger);
const realGit = gitSlice.build(unstubbed<CompositionCore>("core", {})).git;

const originsOf = (entries: readonly ReturnType<typeof isolatedAgent>[]) => {
    const agents = unstubbed<AgentsRegistry>("agents", {
        ids: () => entries.map((entry) => entry.id),
        entry: (id) => entries.find((entry) => entry.id === id),
        markLandingAbsorbed: async () => {},
    });
    return createAgentOrigins({ agents, logger, expiry: createExpiryTracker(defaultGit) });
};

// What a door does once the land's lease is released, and the wait a version commit makes before it commits.
const landThenDerive = async (worktrees: AgentWorktrees, work: string, entry: Parameters<typeof landAgent>[1]) => {
    const landed = await landAgent(worktrees, entry);
    afterLand({ agentWorktrees: worktrees, logger }, entry.id, landed);
    await rederiveSettled([work]);
    return landed;
};

const FIXERS = `import { readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
const dir = process.argv[process.argv.indexOf("--worktree") + 1];
const src = join(dir, "src");
writeFileSync(join(dir, "derived.txt"), readdirSync(src).sort().map((name) => readFileSync(join(src, name), "utf8")).join(""));
console.log("writing derived.txt");
console.log(JSON.stringify({ ran: ["derived"], wrote: ["derived.txt"] }));
`;

const tempDirs: string[] = [];
afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

const write = async (dir: string, files: Readonly<Record<string, string>>): Promise<void> => {
    for (const [path, text] of Object.entries(files)) {
        await mkdir(dirname(join(dir, path)), { recursive: true });
        await writeFile(join(dir, path), text);
    }
};

const setup = async (): Promise<{ work: string; worktrees: AgentWorktrees }> => {
    const base = await mkdtemp(join(tmpdir(), "intentic-derived-"));
    tempDirs.push(base);
    const work = join(base, "work");
    const historyRoot = join(base, "history");
    const workspace = workspacePaths(work);
    await mkdir(work, { recursive: true });
    await ensureRootRepo(workspace, historyRoot);
    await write(work, {
        ".gitattributes": "/derived.txt merge=derived\n",
        "src/a.txt": "a\n",
        "src/b.txt": "b\n",
        "derived.txt": "a\nb\n",
        [REPO_FIXERS]: FIXERS,
    });
    await sh(work, "add", "-A");
    await commit(work, "baseline");
    const worktrees = createAgentWorktrees({ workspace, worktreesRoot: join(historyRoot, "worktrees"), historyRoot, isolation: noIsolation(work, historyRoot), logger, perf });
    return { work, worktrees };
};

test("two conversations that both moved a derived file land one after the other, and the tree holds what its sources make", async () => {
    const { work, worktrees } = await setup();
    const first = await worktrees.ensure("c1", []);
    const second = await worktrees.ensure("c2", []);
    // Each wrote its own copy of the derived file, as an agent running the generator to make its tests pass does.
    await write(first.cwd, { "src/a.txt": "a1\n", "derived.txt": "a1\nb\n" });
    await write(second.cwd, { "src/b.txt": "b2\n", "derived.txt": "a\nb2\n" });

    const landedFirst = await landThenDerive(worktrees, work, isolatedAgent(first.repos));
    expect(landedFirst.landed).toBe(true);
    expect(landedFirst.rederive?.map(({ repo, main }) => ({ repo, main }))).toEqual([{ repo: "root", main: work }]);
    expect(await readFile(join(work, "derived.txt"), "utf8")).toBe("a1\nb\n");

    // As text the second copy cannot apply over the first (its context line `a` is `a1` now): no land carries it.
    const landedSecond = await landThenDerive(worktrees, work, isolatedAgent(second.repos, { id: "c2" }));
    expect(landedSecond.conflicts).toBeUndefined();
    expect(landedSecond.landed).toBe(true);
    expect(await readFile(join(work, "src/b.txt"), "utf8")).toBe("b2\n");
    expect(await readFile(join(work, "derived.txt"), "utf8")).toBe("a1\nb2\n");
});

test("a branch's stale copy of a derived file never reaches the tree it lands in", async () => {
    const { work, worktrees } = await setup();
    const conversation = await worktrees.ensure("c1", []);
    // The agent moved a source and left the derived file as it found it.
    await write(conversation.cwd, { "src/a.txt": "a1\n", "derived.txt": "left behind\n" });
    const landed = await landThenDerive(worktrees, work, isolatedAgent(conversation.repos));
    expect(landed.landed).toBe(true);
    expect(await readFile(join(work, "derived.txt"), "utf8")).toBe("a1\nb\n");
});

test("a land is a git operation: it returns with its patch in the tree and no fixer run, and the writers run after", async () => {
    const { work, worktrees } = await setup();
    const conversation = await worktrees.ensure("c1", []);
    await write(conversation.cwd, { "src/a.txt": "a1\n" });
    const landed = await landAgent(worktrees, isolatedAgent(conversation.repos));
    expect(landed.landed).toBe(true);
    expect(await readFile(join(work, "src/a.txt"), "utf8")).toBe("a1\n");
    // Nothing derived yet: the land ran no fixer, under its locks or anywhere else.
    expect(await readFile(join(work, "derived.txt"), "utf8")).toBe("a\nb\n");
    afterLand({ agentWorktrees: worktrees, logger }, "c1", landed);
    await rederiveSettled([work]);
    expect(await readFile(join(work, "derived.txt"), "utf8")).toBe("a1\nb\n");
});

test("lands that come while the writers run are folded into one next run, under the repo lock", async () => {
    const { work, worktrees } = await setup();
    const first = await worktrees.ensure("c1", []);
    const second = await worktrees.ensure("c2", []);
    const third = await worktrees.ensure("c3", []);
    await write(first.cwd, { "src/a.txt": "a1\n" });
    await write(second.cwd, { "src/b.txt": "b2\n" });
    await write(third.cwd, { "src/c.txt": "c3\n" });
    const runs: string[][] = [];
    const locked: boolean[] = [];
    const { promise: started, resolve: start } = Promise.withResolvers<void>();
    const { promise: released, resolve: release } = Promise.withResolvers<void>();
    const run = async (_dir: string, pathsFile: string): Promise<string> => {
        runs.push((await readFile(pathsFile, "utf8")).split("\n"));
        // The first run is held, so the next two lands come while it is going.
        if (runs.length === 1) {
            start();
            await released;
        }
        // Under the repo lock: a land into the same repo cannot be writing the tree now.
        locked.push(worktrees.repoBusy("root"));
        return JSON.stringify({ ran: [], wrote: [] });
    };
    // Landed first: a land takes the repo lock a run holds, so one pressed during the held run would wait it out.
    const one = await landAgent(worktrees, isolatedAgent(first.repos));
    const two = await landAgent(worktrees, isolatedAgent(second.repos, { id: "c2" }));
    const three = await landAgent(worktrees, isolatedAgent(third.repos, { id: "c3" }));
    // Each hand-off reads its delta's paths first; the held run is released once the later two are both queued.
    let read = 0;
    const { promise: bothRead, resolve: readBoth } = Promise.withResolvers<void>();
    const git: typeof defaultGit = async (cwd, args, options) => {
        const answer = await defaultGit(cwd, args, options);
        read += 1;
        if (read === 3) {
            readBoth();
        }
        return answer;
    };
    const handOff = (id: string, outcome: typeof one): void => scheduleRederive({ agentWorktrees: worktrees, logger }, id, outcome.rederive ?? [], git, run);
    handOff("c1", one);
    await started;
    handOff("c2", two);
    handOff("c3", three);
    await bothRead;
    await new Promise((resolve) => setTimeout(resolve, 0));
    release();
    await rederiveSettled([work]);
    expect(runs).toEqual([["src/a.txt"], ["src/b.txt", "src/c.txt"]]);
    expect(locked).toEqual([true, true]);
});

test("a derived path reads as landed, and while it differs from HEAD it is the newest landing's alone", async () => {
    const { work, worktrees } = await setup();
    const first = await worktrees.ensure("c1", []);
    await write(first.cwd, { "src/a.txt": "a1\n", "derived.txt": "mine\n" });
    const landedFirst = await landThenDerive(worktrees, work, isolatedAgent(first.repos));
    const second = await worktrees.ensure("c2", []);
    await write(second.cwd, { "src/b.txt": "b2\n" });
    const landedSecond = await landThenDerive(worktrees, work, isolatedAgent(second.repos, { id: "c2" }));

    // The branch's own copy differs from the tree's, and still counts as in it: the tree wrote its own.
    const tip = await sh(first.cwd, "rev-parse", "HEAD");
    const presence = await presenceOf(work, first.cwd, tip, ["derived.txt", "src/a.txt"]);
    expect([...presence.inWorkspace].toSorted()).toEqual(["derived.txt", "src/a.txt"]);

    const entries = [isolatedAgent(landedFirst.repos), isolatedAgent(landedSecond.repos, { id: "c2" })];
    const origins = originsOf(entries);
    // The next commit of landed work carries it, from the sources it was written from.
    expect(await origins.forRepo("root", work)).toEqual({ "src/a.txt": ["c1"], "src/b.txt": ["c2"], "derived.txt": ["c2"] });
});

test("a scan before background generation never hides its later writes or keeps a reverted output attributed", async () => {
    const { work, worktrees } = await setup();
    const conversation = await worktrees.ensure("c1", []);
    await write(conversation.cwd, { "src/a.txt": "a1\n" });
    const landed = await landAgent(worktrees, isolatedAgent(conversation.repos));
    const origins = originsOf([isolatedAgent(landed.repos)]);
    const before = await origins.forRepo("root", work);
    expect(before).toEqual({ "src/a.txt": ["c1"] });

    afterLand({ agentWorktrees: worktrees, logger }, "c1", landed);
    await rederiveSettled([work]);
    expect(await origins.forRepo("root", work)).toEqual({ "src/a.txt": ["c1"], "derived.txt": ["c1"] });
    // Source claims may be cached; the mutable generated output must be read again, without mutating prior answers.
    expect(before).toEqual({ "src/a.txt": ["c1"] });
    await write(work, { "derived.txt": "a\nb\n" });
    expect(await origins.forRepo("root", work)).toEqual({ "src/a.txt": ["c1"] });
});

test("staging releases the lock and waits again when a land queues generation while it was acquiring the lock", async () => {
    const { work, worktrees } = await setup();
    const conversation = await worktrees.ensure("c1", []);
    await write(conversation.cwd, { "src/a.txt": "a1\n" });
    const landed = await landAgent(worktrees, isolatedAgent(conversation.repos));
    let attempts = 0;
    const result = await withRederivedRepo(work, (run) => {
        attempts += 1;
        if (attempts === 1) {
            afterLand({ agentWorktrees: worktrees, logger }, "c1", landed);
        }
        return worktrees.withRepoLock("root", run);
    }, async () => {
        expect(worktrees.repoBusy("root")).toBe(true);
        return readFile(join(work, "derived.txt"), "utf8");
    });
    expect(attempts).toBe(2);
    expect(result).toBe("a1\nb\n");
});

test.each(["chip", "scope", "commit", "stage-run", "commit-run"] as const)("%s includes background outputs with landed work and preserves unrelated staging", async (mode) => {
    const { work, worktrees } = await setup();
    const conversation = await worktrees.ensure("c1", []);
    await write(conversation.cwd, { "src/a.txt": "a1\n" });
    const landed = await landAgent(worktrees, isolatedAgent(conversation.repos));
    const origins = originsOf([isolatedAgent(landed.repos)]);
    expect(await origins.forRepo("root", work)).toEqual({ "src/a.txt": ["c1"] });
    // A staged snapshot with a later worktree edit must survive staging the agent's work.
    await write(work, { "owner.txt": "staged\n" });
    await sh(work, "add", "owner.txt");
    await write(work, { "owner.txt": "unstaged\n", "unrelated.txt": "leave me\n" });

    const handOff = Promise.withResolvers<void>();
    scheduleRederive({ agentWorktrees: worktrees, logger }, "c1", landed.rederive ?? [], async (cwd, args, options) => {
        await handOff.promise;
        return defaultGit(cwd, args, options);
    });
    const client = clientFor(createApp(services({ workspace: workspacePaths(work), git: realGit, agentWorktrees: worktrees, agentOrigins: origins })));
    const scope = { origin: "c1" };
    const message = "fix: landed sources";
    // The writer has not even taken its lock yet. Start the user operation before allowing the hand-off through.
    const operation = mode === "chip" ? client.git.stage({ repo: "root", chip: "c1" })
        : mode === "scope" ? client.git.stage({ repo: "root", scope })
        : mode === "commit" ? client.git.commit({ repo: "root", stage: { scope }, message })
        : mode === "stage-run" ? client.git.indexRunStart({ repo: "root", op: "stage", target: { scope } })
        : client.git.indexRunStart({ repo: "root", op: "commit", target: { scope }, message });
    try {
        if (mode === "stage-run" || mode === "commit-run") {
            await operation;
            expect((await client.git.indexRunState({ repo: "root" })).phase).toBe("waiting");
        }
    } finally {
        handOff.resolve();
    }
    await operation;
    if (mode === "stage-run" || mode === "commit-run") {
        await waitFor(async () => expect((await client.git.indexRunState({ repo: "root" })).status).toBe("passed"), SETTLES);
        expect((await client.git.indexRunState({ repo: "root" })).files).toEqual({ total: 2, done: 2 });
    }
    if (mode !== "commit" && mode !== "commit-run") {
        expect(await sh(work, "diff", "--cached", "--name-only")).toBe("derived.txt\nowner.txt\nsrc/a.txt");
        expect(await client.git.commit({ repo: "root", message })).toMatchObject({ committed: true });
    }
    expect(await sh(work, "show", "--format=", "--name-only", "HEAD")).toBe("derived.txt\nowner.txt\nsrc/a.txt");
    expect(await sh(work, "show", "HEAD:derived.txt")).toBe("a1\nb");
    expect(await sh(work, "show", "HEAD:owner.txt")).toBe("staged");
    expect(await sh(work, "status", "--porcelain")).toBe("M owner.txt\n?? unrelated.txt");
});

test("with the repository's merge driver armed, a sync onto a main that moved the derived file does not stop on it", async () => {
    const { work, worktrees } = await setup();
    // What _tools/scripts/ci/githooks.mjs configures on install.
    await sh(work, "config", "merge.derived.driver", "true");
    const conversation = await worktrees.ensure("c1", []);
    await write(conversation.cwd, { "src/a.txt": "a1\n", "derived.txt": "a1\nb\n" });
    await sh(conversation.cwd, "add", "-A");
    await commit(conversation.cwd, "a1");
    await write(work, { "src/b.txt": "b2\n", "derived.txt": "a\nb2\n" });
    await commit(work, "b2");

    const [synced] = await syncConversation(worktrees, "c1", conversation.repos, "a1");
    expect(synced?.blocked).toBeUndefined();
    expect(await readFile(join(conversation.cwd, "src/b.txt"), "utf8")).toBe("b2\n");
    expect(await readFile(join(conversation.cwd, "src/a.txt"), "utf8")).toBe("a1\n");
});
