import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { defaultGit, type GitRunner } from "@intentic/base/git";
import { droppedRef } from "../../../git/agent-refs.js";
import type { RepoRecord } from "../../registry/agents-store.js";
import { isolatedAgent } from "../../registry/agents-store.testing.js";
import { noIsolation } from "../../worktrees/isolation.testing.js";
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

// THE 2026-10-20 INCIDENT, end to end: the parent renamed a file the child then edited, and the child also moved a file
// the repository derives. A `merge` reported "conflict markers to resolve" and wrote nothing, the child read landed, and
// its next catch-up rebased every commit away. Each step is now held to what the tree actually holds.
const FRAMES = "src/run/error-frames.ts";
const RENAMED = "src/run/frames/error-frames.ts";
const frames = (five: string): string => `${Array.from({ length: 10 }, (_, index) => (index === 4 ? five : `line ${index + 1}`)).join("\n")}\n`;

// A family whose parent has committed a derived lock and the file about to be renamed, with the child standing on it.
const renameFamily = async (): Promise<Awaited<ReturnType<typeof family>> & { base: string }> => {
    const kin = await family();
    await sh(kin.work, "config", "merge.derived.driver", "true");
    await mkdir(join(kin.parent, "src/run"), { recursive: true });
    await writeFile(join(kin.parent, ".gitattributes"), "lock.json merge=derived\n");
    await writeFile(join(kin.parent, "lock.json"), "{ \"v\": 1 }\n");
    await writeFile(join(kin.parent, FRAMES), frames("line 5"));
    const base = await commit(kin.parent, "Agent: before c1 caught up");
    await sh(kin.child, "merge", "-q", "--ff-only", base);
    return { ...kin, base };
};

// The child edits the file and the derived lock; the parent renames the file, and, where asked, edits the same line.
const clash = async (kin: { parent: string; child: string }, parentLine: string | undefined): Promise<string> => {
    await writeFile(join(kin.child, FRAMES), frames("five CHILD"));
    await writeFile(join(kin.child, "lock.json"), "{ \"v\": 2 }\n");
    const tip = await commit(kin.child, "Agent: the child's turn");
    await mkdir(join(kin.parent, "src/run/frames"), { recursive: true });
    await sh(kin.parent, "mv", FRAMES, RENAMED);
    if (parentLine !== undefined) {
        await writeFile(join(kin.parent, RENAMED), frames(parentLine));
    }
    await writeFile(join(kin.parent, "lock.json"), "{ \"v\": 3 }\n");
    return tip;
};

test("a check land of a child that edited a file its parent renamed is held, naming it, with nothing written", async () => {
    const kin = await renameFamily();
    await clash(kin, "five PARENT");
    await commit(kin.parent, "Agent: the parent renames");

    const held = await landAgent(kin.worktrees, childEntry([{ repo: "root", base: kin.base }]), "check", "outstanding", "p1");

    expect({ landed: held.landed, paths: held.conflicts?.flatMap(({ paths }) => paths), tip: held.repos[0]?.landedTip }).toEqual({
        landed: false,
        paths: [{ path: FRAMES, reason: "diverged" }],
        tip: undefined,
    });
    expect(await sh(kin.parent, "status", "--porcelain")).toBe("");
});

test("a merge writes the clash as markers in the file under its new name, never the derived lock, and only then reads landed", async () => {
    const kin = await renameFamily();
    const tip = await clash(kin, "five PARENT");
    await commit(kin.parent, "Agent: the parent renames");

    const merged = await landAgent(kin.worktrees, childEntry([{ repo: "root", base: kin.base }]), "merge", "outstanding", "p1");

    expect({ landed: merged.landed, resolving: merged.resolving, tip: merged.repos[0]?.landedTip }).toEqual({
        landed: true,
        resolving: [{ repo: "root", paths: [RENAMED] }],
        tip,
    });
    const written = await readFile(join(kin.parent, RENAMED), "utf8");
    expect([written.includes("<<<<<<<"), written.includes("five PARENT"), written.includes("five CHILD")]).toEqual([true, true, true]);
    expect(existsSync(join(kin.parent, FRAMES))).toBe(false);
    expect(await readFile(join(kin.parent, "lock.json"), "utf8")).toBe('{ "v": 3 }\n');

    // Merged again, nothing is outstanding and nothing is written: never "in your checkout now" twice.
    const again = await landAgent(kin.worktrees, childEntry(merged.repos), "merge", "outstanding", "p1");
    expect({ landed: again.landed, changed: again.changed, resolving: again.resolving }).toEqual({ landed: true, changed: false, resolving: undefined });
});

test("a merge follows a rename the parent has not committed, through its uncommitted edits, with no markers where nothing clashes", async () => {
    const kin = await renameFamily();
    await clash(kin, undefined);

    const merged = await landAgent(kin.worktrees, childEntry([{ repo: "root", base: kin.base }]), "merge", "outstanding", "p1");

    expect({ landed: merged.landed, resolving: merged.resolving }).toEqual({ landed: true, resolving: undefined });
    expect(await readFile(join(kin.parent, RENAMED), "utf8")).toBe(frames("five CHILD"));
    // The parent's own staged rename is still what its index holds: the merge writes the working tree alone.
    expect(await sh(kin.parent, "diff", "--cached", "--name-status", "-M")).toContain(RENAMED);
});

// A tree that takes a write and does not hold it afterwards (what `git apply --3way` did with a renamed file) is
// stood in for by a runner whose `apply` writes nothing.
const applyWritesNothing: GitRunner = async (dir, args, env) =>
    args[0] === "apply" && !args.includes("--check") ? { stdout: "", stderr: "" } : defaultGit(dir, args, env);

test.each(["check", "merge"] as const)("a %s land whose write the tree does not hold is a conflict, and its tip does not move", async (mode) => {
    const kin = await renameFamily();
    await writeFile(join(kin.parent, FRAMES), frames("five PARENT"));
    await commit(kin.parent, "Agent: the parent edits");
    await writeFile(join(kin.child, "checkout.ts"), "export const checkout = true;\n");
    if (mode === "merge") {
        await writeFile(join(kin.child, FRAMES), frames("five CHILD"));
    }
    const entry = childEntry([{ repo: "root", base: kin.base }]);

    const landed = await landAgent(kin.worktrees, entry, mode, "outstanding", "p1", applyWritesNothing);

    expect({ landed: landed.landed, resolving: landed.resolving, repos: landed.repos }).toEqual({ landed: false, resolving: undefined, repos: entry.placement.repos });
    expect(landed.conflicts?.flatMap(({ paths }) => paths)).toContainEqual({ path: "checkout.ts", reason: "workspace" });
});

test("a child's catch-up keeps every commit its parent does not hold, whatever its landed tip says", async () => {
    const kin = await renameFamily();
    // The rung the old merge left: the child's whole tip recorded landed, though nothing of it reached the parent.
    const tip = await clash(kin, undefined);
    const head = await commit(kin.parent, "Agent: the parent renames");

    const [root] = await syncConversation(kin.worktrees, "c1", [{ repo: "root", base: kin.base, landedTip: tip }], "t", { kind: "parent", parent: "p1" });

    expect({ onto: root?.onto, blocked: root?.blocked }).toEqual({ onto: head, blocked: undefined });
    // Replayed, not dropped: the child's edit followed the rename onto the parent's newest commit.
    expect(await sh(kin.child, "rev-list", "--count", `${head}..HEAD`)).toBe("1");
    expect(await readFile(join(kin.child, RENAMED), "utf8")).toBe(frames("five CHILD"));
    expect(await sh(kin.work, "for-each-ref", droppedRef("c1"))).toBe("");
});

test("a child's catch-up drops what it landed once the parent holds it, pinning the tip it had", async () => {
    const kin = await renameFamily();
    await writeFile(join(kin.child, "checkout.ts"), "export const checkout = true;\n");
    const landed = await landAgent(kin.worktrees, childEntry([{ repo: "root", base: kin.base }]), "check", "outstanding", "p1");
    expect(landed.landed).toBe(true);
    await writeFile(join(kin.child, "more.ts"), "export const more = true;\n");
    const before = await commit(kin.child, "Agent: the child's next turn");

    const [root] = await syncConversation(kin.worktrees, "c1", landed.repos, "t", { kind: "parent", parent: "p1" });

    const head = await sh(kin.parent, "rev-parse", "HEAD");
    expect({ onto: root?.onto, blocked: root?.blocked }).toEqual({ onto: head, blocked: undefined });
    expect(await sh(kin.child, "log", "--format=%s", `${head}..HEAD`)).toBe("Agent: the child's next turn");
    expect(await sh(kin.work, "rev-parse", droppedRef("c1"))).toBe(before);
});
