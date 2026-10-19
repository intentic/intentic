import { execFile } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { IN_MEMORY } from "@intentic/base/sqlite";
import type { Rule } from "@intentic/sandbox-contract/schemas/settings";
import { unstubbed } from "@intentic/testing";
import type { Services } from "../../../composition.js";
import { commitRootBaseline, ensureRootRepo } from "../../../git/remote/root-repo.js";
import { createLogger } from "../../../logger.js";
import { openConversationsDb } from "../../../store/conversations-db.js";
import { createPerfTracker } from "../../../system/resources/perf.js";
import { workspacePaths } from "../../../workspace/workspace.js";
import type { Fleet, FleetStore } from "../../registry/agents-registry.js";
import { fleetStoreOver, memoryFleet } from "../../registry/agents-registry.testing.js";
import { isolatedAgent } from "../../registry/agents-store.testing.js";
import { createExpiryTracker } from "../../registry/expiry.js";
import { noIsolation } from "../../worktrees/isolation.testing.js";
import { createAgentWorktrees, type AgentWorktrees } from "../../worktrees/worktrees.js";
import { landAgent } from "../land.js";
import { createAgentOrigins } from "../origins.js";
import { settlePendingVersions, versionCommitsSettled, versionMainTree } from "../version-landed.js";

// A land's version commit is made off the land's own clock, after a model drafts its subject. A daemon that died in
// between left the landed paths uncommitted, and the next isolated turn took them into the owner's "Your edits" with no
// conversation trailer. Each case lands for real, drops the daemon that landed (its fleet, its in-memory holds), and
// boots another over the same conversations database and the same main tree.

const exec = promisify(execFile);
const sh = async (cwd: string, ...args: string[]): Promise<string> => (await exec("git", ["-C", cwd, ...args])).stdout.trim();
const logger = createLogger({ logLevel: "silent", logPretty: false, historyRoot: "" });
const perf = createPerfTracker(logger);

const ID = "c1";
const TITLE = "write the release notes";
const VERSION: Rule = { id: "auto-version", label: "Version lands", moment: "agent.landed", action: { kind: "builtin", name: "version-landed" }, enabled: true };

const tempDirs: string[] = [];
afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

interface Tree {
    readonly work: string;
    readonly worktrees: AgentWorktrees;
    readonly store: FleetStore;
}

const setup = async (): Promise<Tree> => {
    const base = await mkdtemp(join(tmpdir(), "intentic-version-pending-"));
    tempDirs.push(base);
    const work = join(base, "work");
    const historyRoot = join(base, "history");
    const workspace = workspacePaths(work);
    await ensureRootRepo(workspace, historyRoot);
    await writeFile(join(work, "README.md"), "# readme\n");
    await commitRootBaseline(workspace);
    const worktrees = createAgentWorktrees({ workspace, worktreesRoot: join(historyRoot, "worktrees"), historyRoot, isolation: noIsolation(work, historyRoot), logger, perf });
    return { work, worktrees, store: fleetStoreOver(openConversationsDb(IN_MEMORY)) };
};

// A daemon over the tree: a fresh registry loaded from the database as a boot loads it, and the services the version
// commit reads. No commit-message model is set, so the subject is the conversation's title, as an undrafted land's is.
const boot = async ({ worktrees, store }: Tree): Promise<{ readonly fleet: Fleet; readonly services: Services }> => {
    const fleet = memoryFleet(store);
    await fleet.agents.init();
    const services = unstubbed<Services>("services", {
        agents: fleet.agents,
        agentWorktrees: worktrees,
        agentOrigins: createAgentOrigins({ agents: fleet.agents, logger, expiry: createExpiryTracker() }),
        // SAFETY: the version commit reads `rules` alone off the settings; the rest of the document is never touched here.
        sandboxSettings: unstubbed<Services["sandboxSettings"]>("sandboxSettings", { get: async () => ({ rules: [VERSION] }) as never }),
        turnEngine: unstubbed<Services["turnEngine"]>("turnEngine", { roleModelIsSet: async () => false }),
        transcripts: unstubbed<Services["transcripts"]>("transcripts", { lastSaid: async () => undefined }),
        ruleFirings: unstubbed<Services["ruleFirings"]>("ruleFirings", { stamp: async () => undefined }),
        logger,
    });
    return { fleet, services };
};

// The daemon that lands: the conversation's checkout, its work, the land into the main tree, and its record written as
// a land writes it. Then it dies before its settle runs: nothing of it but the database and the tree goes on.
const landThenDie = async (tree: Tree): Promise<void> => {
    const opened = await tree.worktrees.ensure(ID, []);
    await writeFile(join(tree.worktrees.worktreeDir(ID, "root"), "NOTES.md"), "# notes\n");
    tree.store.agents.save([isolatedAgent(opened.repos, { id: ID, social: { title: { text: TITLE, source: "user" }, reactions: [] } })]);
    const { fleet } = await boot(tree);
    const entry = fleet.agents.entry(ID);
    if (entry?.placement.kind !== "worktree") {
        throw new Error("the conversation has no checkout");
    }
    const outcome = await landAgent(tree.worktrees, { ...entry, placement: entry.placement });
    expect(outcome.landed).toBe(true);
    await fleet.agents.recordLanded(ID, outcome);
    expect(fleet.agents.entry(ID)?.landMarks?.versionPending).toBeGreaterThan(0);
};

const log = async (work: string): Promise<string[]> => (await sh(work, "log", "--format=%B%x00")).split("\0").map((message) => message.trim()).filter((message) => message !== "");

test("the boot makes the version commit a restart cut, under the land's subject and trailer, before a turn's remainder", async () => {
    const tree = await setup();
    await landThenDie(tree);
    // The owner's own edit, made while the daemon was down.
    await writeFile(join(tree.work, "scratch.md"), "mine\n");

    const { fleet, services } = await boot(tree);
    expect(settlePendingVersions(services)).toEqual([ID]);
    // What the next isolated turn does as it opens, at once: it waits for that commit rather than taking its paths.
    await versionMainTree(services, ["root"]);

    const [remainder, landed] = await log(tree.work);
    expect(landed).toBe(`Agent: ${TITLE}\n\nConversation-Id: ${ID}`);
    expect(await sh(tree.work, "show", "--name-only", "--format=", "HEAD~1")).toBe("NOTES.md");
    expect(remainder).toBe("Your edits");
    expect(await sh(tree.work, "show", "--name-only", "--format=", "HEAD")).toBe("scratch.md");
    expect(fleet.agents.entry(ID)?.landMarks).toBeUndefined();

    // Nothing is owed any more: a further restart commits nothing twice.
    const commits = (await log(tree.work)).length;
    const again = await boot(tree);
    expect(settlePendingVersions(again.services)).toEqual([]);
    await versionCommitsSettled(again.services, ["root"]);
    expect((await log(tree.work)).length).toBe(commits);
});

test("a turn's remainder leaves a pending land's paths alone, and its own commit takes them once it runs", async () => {
    const tree = await setup();
    await landThenDie(tree);
    await writeFile(join(tree.work, "scratch.md"), "mine\n");

    // A daemon whose settle has not run (the boot step did not reach it, or its draft outlasted the wait).
    const { services } = await boot(tree);
    await versionMainTree(services, ["root"]);
    expect(await sh(tree.work, "show", "--name-only", "--format=%s", "HEAD")).toBe("Your edits\n\nscratch.md");
    expect(await sh(tree.work, "status", "--porcelain")).toBe("?? NOTES.md");

    settlePendingVersions(services);
    await versionCommitsSettled(services, ["root"]);
    expect((await log(tree.work))[0]).toBe(`Agent: ${TITLE}\n\nConversation-Id: ${ID}`);
    expect(await sh(tree.work, "status", "--porcelain")).toBe("");
});
