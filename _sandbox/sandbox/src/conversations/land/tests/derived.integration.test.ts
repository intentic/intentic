import { execFile } from "node:child_process";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { promisify } from "node:util";
import { defaultGit } from "@intentic/base/git";
import { unstubbed } from "@intentic/testing";
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
import { REPO_FIXERS } from "../rederive.js";
import { syncConversation } from "../sync.js";

// A file the repository marks `merge=derived` is a function of the tree it sits in. The evidence this pins: in two weeks
// of October, 21 lands were refused on intentic's contract.lock.json alone, each a pair of conversations that had both
// moved the contract, and five of main's CI runs failed on a lock nobody had written again. Here `derived.txt` is every
// file of `src/` in name order, and the repository's own fixers (a stand-in for _tools/scripts/verify/fixers.mjs) write
// it. Two lines next to each other, so two conversations that each moved one of them cannot both apply as text.

const exec = promisify(execFile);
const sh = async (cwd: string, ...args: string[]): Promise<string> => (await exec("git", ["-C", cwd, ...args])).stdout.trim();
const commit = (cwd: string, message: string): Promise<string> => sh(cwd, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-am", message);
const logger = createLogger({ logLevel: "silent", logPretty: false, historyRoot: "" });
const perf = createPerfTracker(logger);

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

    const landedFirst = await landAgent(worktrees, isolatedAgent(first.repos));
    expect(landedFirst.landed).toBe(true);
    expect(landedFirst.derived).toEqual([{ repo: "root", ran: ["derived"], wrote: ["derived.txt"] }]);

    // As text the second copy cannot apply over the first (its context line `a` is `a1` now): no land carries it.
    const landedSecond = await landAgent(worktrees, isolatedAgent(second.repos, { id: "c2" }));
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
    const landed = await landAgent(worktrees, isolatedAgent(conversation.repos));
    expect(landed.landed).toBe(true);
    expect(await readFile(join(work, "derived.txt"), "utf8")).toBe("a1\nb\n");
});

test("a derived path reads as landed, and while it differs from HEAD it is the newest landing's alone", async () => {
    const { work, worktrees } = await setup();
    const first = await worktrees.ensure("c1", []);
    await write(first.cwd, { "src/a.txt": "a1\n", "derived.txt": "mine\n" });
    const landedFirst = await landAgent(worktrees, isolatedAgent(first.repos));
    const second = await worktrees.ensure("c2", []);
    await write(second.cwd, { "src/b.txt": "b2\n" });
    const landedSecond = await landAgent(worktrees, isolatedAgent(second.repos, { id: "c2" }));

    // The branch's own copy differs from the tree's, and still counts as in it: the tree wrote its own.
    const tip = await sh(first.cwd, "rev-parse", "HEAD");
    const presence = await presenceOf(work, first.cwd, tip, ["derived.txt", "src/a.txt"]);
    expect([...presence.inWorkspace].toSorted()).toEqual(["derived.txt", "src/a.txt"]);

    const entries = [isolatedAgent(landedFirst.repos), isolatedAgent(landedSecond.repos, { id: "c2" })];
    const agents = unstubbed<AgentsRegistry>("agents", {
        ids: () => entries.map((entry) => entry.id),
        entry: (id) => entries.find((entry) => entry.id === id),
        markLandingAbsorbed: async () => {},
    });
    const origins = createAgentOrigins({ agents, logger, expiry: createExpiryTracker(defaultGit) });
    // The next commit of landed work carries it, from the sources it was written from.
    expect(await origins.forRepo("root", work)).toEqual({ "src/a.txt": ["c1"], "src/b.txt": ["c2"], "derived.txt": ["c2"] });
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
