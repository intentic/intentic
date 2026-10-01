import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import type { RepoRecord } from "../../registry/agents-store.js";
import { isolatedAgent, noIsolation } from "../../../testing.js";
import { ensureRootRepo } from "../../../git/remote/root-repo.js";
import { createLogger } from "../../../logger.js";
import { createPerfTracker } from "../../../system/resources/perf.js";
import { workspacePaths } from "../../../workspace/workspace.js";
import { landAgent } from "../land.js";
import { syncConversation } from "../sync.js";
import { createAgentWorktrees, type AgentWorktrees } from "../../worktrees/worktrees.js";

// A spawned child cut from its parent's checkout works for the parent as the parent's in-process subagents do: its own
// work, and only its own, goes into the parent's checkout, never into the main tree, and a clash with what the parent
// has written holds it off whole. Real git over a temp workspace: the parent's and the child's worktrees share the
// main repo's object store, exactly as the daemon's do.

const exec = promisify(execFile);
const sh = async (cwd: string, ...args: string[]): Promise<string> => (await exec("git", ["-C", cwd, ...args])).stdout.trim();
const commit = async (cwd: string, message: string): Promise<string> => {
    await sh(cwd, "add", "-A");
    await sh(cwd, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", message);
    return sh(cwd, "rev-parse", "HEAD");
};
const logger = createLogger({ logLevel: "silent", logPretty: false, historyRoot: "" });
const perf = createPerfTracker(logger);

const tempDirs: string[] = [];
afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

// A workspace, a parent conversation that has committed work of its own, and a child cut from that commit.
const family = async (): Promise<{ work: string; worktrees: AgentWorktrees; parent: string; child: string; cut: string }> => {
    const base = await mkdtemp(join(tmpdir(), "intentic-land-parent-"));
    tempDirs.push(base);
    const work = join(base, "work");
    const historyRoot = join(base, "history");
    const workspace = workspacePaths(work);
    await mkdir(work, { recursive: true });
    await ensureRootRepo(workspace, historyRoot);
    await writeFile(join(work, "app.ts"), "line one\nline two\nline three\n");
    await commit(work, "baseline");
    const worktrees = createAgentWorktrees({
        workspace,
        worktreesRoot: join(historyRoot, "worktrees"),
        historyRoot,
        isolation: noIsolation(work, historyRoot),
        logger,
        perf,
    });
    const parent = (await worktrees.ensure("p1", [])).cwd;
    await writeFile(join(parent, "app.ts"), "line one\nline two PARENT\nline three\n");
    const cut = await commit(parent, "Agent: before starting c1");
    const child = (await worktrees.ensure("c1", [], [{ repo: "root", base: cut }])).cwd;
    return { work, worktrees, parent, child, cut };
};

// The child's registry entry as the daemon files it: cut from its parent (placement.parent), standing on the cut.
const childEntry = (repos: readonly RepoRecord[]) => {
    const agent = isolatedAgent(repos, { id: "c1" });
    return { ...agent, placement: { ...agent.placement, parent: "p1" } };
};

test("lands a child's own work into its parent's checkout, uncommitted, and nothing into the main tree", async () => {
    const { work, worktrees, parent, child, cut } = await family();
    const parentHead = await sh(parent, "rev-parse", "HEAD");
    await writeFile(join(child, "checkout.ts"), "export const checkout = true;\n");

    const landed = await landAgent(worktrees, childEntry([{ repo: "root", base: cut }]), "check", "outstanding", "p1");

    expect({ landed: landed.landed, changed: landed.changed, into: landed.into }).toEqual({ landed: true, changed: true, into: "p1" });
    expect(await readFile(join(parent, "checkout.ts"), "utf8")).toBe("export const checkout = true;\n");
    // Beside the parent's own work, which stays as the parent wrote it; its branch does not move.
    expect(await readFile(join(parent, "app.ts"), "utf8")).toBe("line one\nline two PARENT\nline three\n");
    expect(await sh(parent, "rev-parse", "HEAD")).toBe(parentHead);
    expect(await sh(parent, "status", "--porcelain")).toBe("?? checkout.ts");
    expect(existsSync(join(work, "checkout.ts"))).toBe(false);
    expect(landed.repos[0]?.landedTip).toBe(await sh(child, "rev-parse", "HEAD"));
});

// Measured from the parent commit it was cut from, never from the main line: the parent's work under it is the
// parent's, so even a child landing into the main tree (its parent gone) carries its own change alone.
test("measures a child's delta from the parent commit it stands on, not from the main line", async () => {
    const { work, worktrees, child, cut } = await family();
    await writeFile(join(child, "checkout.ts"), "export const checkout = true;\n");

    const landed = await landAgent(worktrees, childEntry([{ repo: "root", base: cut }]), "check", "outstanding", undefined);

    expect(landed.landed).toBe(true);
    expect(await readFile(join(work, "checkout.ts"), "utf8")).toBe("export const checkout = true;\n");
    expect(await readFile(join(work, "app.ts"), "utf8")).toBe("line one\nline two\nline three\n");
});

test("holds the whole land off the parent's checkout where it clashes with the parent's own edits", async () => {
    const { worktrees, parent, child, cut } = await family();
    await writeFile(join(parent, "app.ts"), "line one\nline two PARENT AGAIN\nline three\n");
    await writeFile(join(child, "app.ts"), "line one\nline two CHILD\nline three\n");
    await writeFile(join(child, "checkout.ts"), "export const checkout = true;\n");

    const landed = await landAgent(worktrees, childEntry([{ repo: "root", base: cut }]), "check", "outstanding", "p1");

    expect({ landed: landed.landed, into: landed.into }).toEqual({ landed: false, into: "p1" });
    expect(landed.conflicts?.flatMap(({ paths }) => paths)).toEqual([{ path: "app.ts", reason: "workspace" }]);
    // All or nothing, as a land into the main tree is: not even the file that would have applied.
    expect(existsSync(join(parent, "checkout.ts"))).toBe(false);
    expect(await readFile(join(parent, "app.ts"), "utf8")).toBe("line one\nline two PARENT AGAIN\nline three\n");
});

// The parent's `merge` door: once what the parent wrote is a commit (the sync onto it commits it first), the clash
// is written with conflict markers for the parent to resolve.
test("merges a clashing child into its parent's checkout with conflict markers once the parent's edits are committed", async () => {
    const { worktrees, parent, child, cut } = await family();
    await writeFile(join(parent, "app.ts"), "line one\nline two PARENT AGAIN\nline three\n");
    await commit(parent, "Agent: before c1 caught up");
    await writeFile(join(child, "app.ts"), "line one\nline two CHILD\nline three\n");

    const merged = await landAgent(worktrees, childEntry([{ repo: "root", base: cut }]), "merge", "outstanding", "p1");

    expect({ landed: merged.landed, resolving: merged.resolving }).toEqual({ landed: true, resolving: [{ repo: "root", paths: ["app.ts"] }] });
    const written = await readFile(join(parent, "app.ts"), "utf8");
    expect([written.includes("<<<<<<<"), written.includes("line two PARENT AGAIN"), written.includes("line two CHILD")]).toEqual([true, true, true]);
});

// Before each turn and each land a child follows its parent: what the parent has written since is committed there
// first, and only the child's own commits are replayed onto it, so its delta stays its own.
test("syncs a child onto its parent's newest work, committing the parent's remainder and replaying only the child's commits", async () => {
    const { worktrees, parent, child, cut } = await family();
    await writeFile(join(child, "checkout.ts"), "export const checkout = true;\n");
    await commit(child, "Agent: the child's turn");
    // The parent carries on: one committed step and one still in its tree.
    await writeFile(join(parent, "pricing.ts"), "export const plans = [];\n");
    await commit(parent, "Agent: parent's next turn");
    await writeFile(join(parent, "notes.md"), "still writing\n");

    const synced = await syncConversation(worktrees, "c1", [{ repo: "root", base: cut }], "port checkout", { kind: "parent", parent: "p1" });

    const parentTip = await sh(parent, "rev-parse", "HEAD");
    expect(synced.map(({ repo, onto, blocked }) => ({ repo, onto, blocked }))).toEqual([{ repo: "root", onto: parentTip, blocked: undefined }]);
    expect(await sh(parent, "status", "--porcelain")).toBe("");
    expect(await sh(child, "log", "--format=%s", `${parentTip}..HEAD`)).toBe("Agent: the child's turn");
    expect(await readFile(join(child, "notes.md"), "utf8")).toBe("still writing\n");

    // Measured from its new base, the child's delta is its own file alone.
    const landed = await landAgent(worktrees, childEntry([{ repo: "root", base: parentTip }]), "check", "outstanding", "p1");
    expect(landed.landed).toBe(true);
    expect(await sh(parent, "status", "--porcelain")).toBe("?? checkout.ts");
});

test("leaves a child where it stands when its upstream is none: rebased onto main, it would carry its parent's work", async () => {
    const { worktrees, child, cut } = await family();
    await writeFile(join(child, "checkout.ts"), "export const checkout = true;\n");
    await commit(child, "Agent: the child's turn");
    const before = await sh(child, "rev-parse", "HEAD");

    expect(await syncConversation(worktrees, "c1", [{ repo: "root", base: cut }], "port checkout", { kind: "none" })).toEqual([]);
    expect(await sh(child, "rev-parse", "HEAD")).toBe(before);
});
