import { execFile } from "node:child_process";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { isolatedAgent } from "../../registry/agents-store.testing.js";
import { noIsolation } from "../../worktrees/isolation.testing.js";
import { ensureRootRepo } from "../../../git/remote/root-repo.js";
import { createLogger } from "../../../logger.js";
import { createPerfTracker } from "../../../system/resources/perf.js";
import { workspacePaths } from "../../../workspace/workspace.js";
import { useCheckoutFeed } from "../../../git/feed/checkout-feed.js";
import type { IsolatedAgent } from "../../registry/agents-store.js";
import type { LandOutcome } from "../land.js";
import { settleByHand } from "../land-by-hand.js";
import { createLandStandings } from "../standing.js";
import { createAgentWorktrees, type AgentWorktrees, type ConversationWorktree } from "../../worktrees/worktrees.js";

// 2026-10-20: a parent brought a held child's work in by hand, adapting it on the way (both sides of a clash kept, a
// version renumbered), and landed. Nothing about the child's content was in main as it stood, so the child read
// `conflict` for good; Discard, which deletes it, was the only press that cleared it.

const exec = promisify(execFile);
const sh = async (cwd: string, ...args: string[]): Promise<string> => (await exec("git", ["-C", cwd, ...args])).stdout.trim();
const commit = (cwd: string, message: string): Promise<string> => sh(cwd, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", message);
const logger = createLogger({ logLevel: "silent", logPretty: false, historyRoot: "" });
const perf = createPerfTracker(logger);
const tempDirs: string[] = [];
afterEach(async () => {
    useCheckoutFeed(undefined);
    for (const dir of tempDirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

const setup = async (): Promise<{ work: string; worktrees: AgentWorktrees; conversation: ConversationWorktree }> => {
    const base = await mkdtemp(join(tmpdir(), "intentic-settle-"));
    tempDirs.push(base);
    const work = join(base, "work");
    const historyRoot = join(base, "history");
    const workspace = workspacePaths(work);
    await mkdir(work, { recursive: true });
    await ensureRootRepo(workspace, historyRoot);
    await writeFile(join(work, "version.ts"), "export const VERSION = \"2.32.0\";\n");
    await sh(work, "add", "-A");
    await commit(work, "baseline");
    const worktrees = createAgentWorktrees({ workspace, worktreesRoot: join(historyRoot, "worktrees"), historyRoot, isolation: noIsolation(work, historyRoot), logger, perf });
    return { work, worktrees, conversation: await worktrees.ensure("c1", []) };
};

const report = [{ repo: "root", paths: [{ path: "version.ts", reason: "diverged" as const }], clean: 0 }];

const standingOf = async (worktrees: AgentWorktrees, entry: IsolatedAgent): Promise<string> => {
    const standings = createLandStandings(worktrees);
    await standings.refresh([entry]);
    return standings.of(entry.id);
};

// The registry's one land write, kept to read back, over the one entry it holds; no parent, so the work was headed for
// the main tree. The lease runs its task at once: nothing else lands here.
const books = (worktrees: AgentWorktrees, held: IsolatedAgent): { deps: Parameters<typeof settleByHand>[0]; recorded: LandOutcome[] } => {
    const recorded: LandOutcome[] = [];
    return {
        recorded,
        deps: {
            agents: {
                entry: (id) => (id === held.id ? held : undefined),
                recordLanded: async (_id, outcome) => {
                    recorded.push(outcome);
                },
            },
            conversations: { withLandLease: (_id, task) => task() },
            agentWorktrees: worktrees,
            logger,
        },
    };
};

// The child claims 2.33.0; the parent's merge kept another child's claim to it and renumbered this one's to 2.34.0.
const adaptedByHand = async (work: string, conversation: ConversationWorktree): Promise<IsolatedAgent> => {
    await writeFile(join(conversation.cwd, "version.ts"), "export const VERSION = \"2.33.0\";\n");
    await sh(conversation.cwd, "add", "-A");
    await commit(conversation.cwd, "agent work");
    await writeFile(join(work, "version.ts"), "export const VERSION = \"2.34.0\";\n");
    await sh(work, "add", "-A");
    await commit(work, "merged by hand, renumbered");
    return isolatedAgent(conversation.repos, { landing: { conflicts: report } });
};

test("work adapted on its way in is still a conflict to the probe, and settling it files it as landed with nothing written", async () => {
    const { work, worktrees, conversation } = await setup();
    const stranded = await adaptedByHand(work, conversation);
    expect(await standingOf(worktrees, stranded)).toBe("conflict");
    const head = await sh(work, "rev-parse", "HEAD");
    const tip = await sh(work, "rev-parse", "agent/c1");

    const { deps, recorded } = books(worktrees, stranded);
    expect(await settleByHand(deps, stranded.id)).toEqual({ settled: true, repos: ["root"] });

    expect(recorded).toHaveLength(1);
    const outcome = recorded[0];
    expect(outcome).toMatchObject({ landed: true, changed: false, advanced: true, adjudicated: true, conflicts: [] });
    expect(outcome?.into).toBeUndefined();
    expect(outcome?.repos).toEqual([{ repo: "root", base: expect.any(String), landedTip: tip, landedAt: expect.any(Number) }]);
    expect(outcome?.repos[0]?.base).toBe(conversation.repos[0]?.base);
    // Nothing written: main is where the person left it, and the branch keeps its commit.
    expect(await sh(work, "rev-parse", "HEAD")).toBe(head);
    expect(await sh(work, "status", "--porcelain")).toBe("");
    expect(await sh(work, "rev-parse", "agent/c1")).toBe(tip);

    expect(await standingOf(worktrees, isolatedAgent(outcome?.repos ?? [], { landing: { conflicts: outcome?.conflicts ?? [] } }))).toBe("landed");
});

test("work the branch gains after it was settled is outstanding again, measured from the settled tip", async () => {
    const { work, worktrees, conversation } = await setup();
    const stranded = await adaptedByHand(work, conversation);
    const { deps, recorded } = books(worktrees, stranded);
    await settleByHand(deps, stranded.id);

    await writeFile(join(conversation.cwd, "later.ts"), "written after the settle\n");
    await sh(conversation.cwd, "add", "-A");
    await commit(conversation.cwd, "later work");
    expect(await standingOf(worktrees, isolatedAgent(recorded[0]?.repos ?? []))).toBe("ready");
});

test("a card that holds nothing records nothing", async () => {
    const { worktrees, conversation } = await setup();
    const { deps, recorded } = books(worktrees, isolatedAgent(conversation.repos));
    expect(await settleByHand(deps, "c1")).toEqual({ settled: false });
    expect(await settleByHand(deps, "nobody")).toEqual({ settled: false });
    expect(recorded).toEqual([]);
});
