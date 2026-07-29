import { mkdir, mkdtemp, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { ANCHOR_READY, inWorktree, type IsolationPlan, isolationScript, MAIN_MOUNT, modulesDirs, nsenterArgv, nsenterPrefix } from "./isolation.js";

/* The namespace itself needs CAP_SYS_ADMIN, which no test runner is guaranteed to have — so what is asserted
 * here is the PLAN: the ordering that makes the mounts correct, and the path translation the daemon depends
 * on. A wrong order fails silently at runtime (the agent writes into a tree that looks right), which is
 * exactly the class of bug worth pinning down in a unit test. */

const tempDirs: string[] = [];
afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

const plan: IsolationPlan = { worktree: "/history/worktrees/abc", root: "/work", modules: ["", "_apps/web"] };

test("the namespace is made private before anything is mounted", () => {
    const lines = isolationScript(plan).split("\n");
    expect(lines[0]).toBe("set -e");
    expect(lines[1]).toBe("mount --make-rprivate /");
    // Every mount comes after it — otherwise the "isolated" turn rewrites the daemon's own /work.
    expect(lines.findIndex((line) => line.startsWith("mount --bind"))).toBeGreaterThan(1);
});

test("the main root is bound aside before the worktree shadows it", () => {
    const script = isolationScript(plan);
    const aside = script.indexOf(`mount --bind '/work' '${MAIN_MOUNT}'`);
    const shadow = script.indexOf(`mount --bind '/history/worktrees/abc' '/work'`);
    expect(aside).toBeGreaterThan(-1);
    expect(shadow).toBeGreaterThan(aside);
});

test("shared state and dependency trees are re-bound from the aside mount, not from the shadowed path", () => {
    const script = isolationScript(plan);
    // Sourcing these from /work would name the worktree's own (empty) copy — the mount would succeed and the
    // agent would silently lose the transcript store.
    expect(script).toContain(`mount --bind '${MAIN_MOUNT}/.intentic' '/work/.intentic'`);
    expect(script).toContain(`mount --bind '${MAIN_MOUNT}/node_modules' '/work/node_modules'`);
    expect(script).toContain(`mount --bind '${MAIN_MOUNT}/_apps/web/node_modules' '/work/_apps/web/node_modules'`);
    // A fresh checkout has no mount point for an untracked dir.
    expect(script).toContain(`mkdir -p '/work/.intentic'`);
});

test("the anchor announces readiness only after the mounts, then becomes the namespace's inhabitant", () => {
    const lines = isolationScript(plan).split("\n");
    // Readiness AFTER the last mount: a caller that starts work on the announcement must never find a
    // half-built namespace writing through to the shared tree.
    expect(lines.at(-2)).toBe(`echo ${ANCHOR_READY}`);
    expect(lines.at(-1)).toBe("exec sleep infinity");
    expect(lines.lastIndexOf(`mount --bind '${MAIN_MOUNT}/_apps/web/node_modules' '/work/_apps/web/node_modules'`)).toBeLessThan(lines.length - 2);
    // `exec`, so the sleep IS the pid nsenter targets — a shell waiting on a child would hold the namespace
    // under a different pid than the one handed out.
    expect(lines.at(-1)?.startsWith("exec ")).toBe(true);
});

test("entrants join the anchor's namespace by pid and start at the workspace root", () => {
    const { command, args } = nsenterArgv(4321, "/work", "/usr/bin/claude", ["--flag", "value"]);
    expect(command).toBe("nsenter");
    expect(args).toEqual(["--mount=/proc/4321/ns/mnt", "--wd=/work", "--", "/usr/bin/claude", "--flag", "value"]);
});

test("the shell-string form quotes its working dir so a path with a space cannot split the command", () => {
    expect(nsenterPrefix(7, "/work dir")).toBe(`nsenter --mount=/proc/7/ns/mnt --wd='/work dir' -- `);
});

test("a path the agent reports is translated back to the worktree for the daemon", () => {
    expect(inWorktree("/work/intentic/src/x.ts", plan)).toBe("/history/worktrees/abc/intentic/src/x.ts");
    // Outside the root: the same file in both namespaces.
    expect(inWorktree("/root/.claude/memory/x.md", plan)).toBe("/root/.claude/memory/x.md");
    // Not isolated at all.
    expect(inWorktree("/work/intentic/src/x.ts", undefined)).toBe("/work/intentic/src/x.ts");
});

test("re-bound subtrees resolve to the main tree in both namespaces and are never translated", () => {
    // Translating these would send the daemon looking in a worktree that has no such file.
    expect(inWorktree("/work/.intentic/attachments/a.png", plan)).toBe("/work/.intentic/attachments/a.png");
    expect(inWorktree("/work/_apps/web/node_modules/vue/index.js", plan)).toBe("/work/_apps/web/node_modules/vue/index.js");
    // A path that merely STARTS like one of them is still worktree content.
    expect(inWorktree("/work/.intentic-notes/x.md", plan)).toBe("/history/worktrees/abc/.intentic-notes/x.md");
});

test("dependency dirs are discovered shallowest-first so a parent never shadows a child", async () => {
    const root = await mkdtemp(join(tmpdir(), "isolation-"));
    tempDirs.push(root);
    await mkdir(join(root, "node_modules"), { recursive: true });
    await mkdir(join(root, "_apps", "web", "node_modules"), { recursive: true });
    await mkdir(join(root, "_libs", "ui", "node_modules"), { recursive: true });
    // Never descended into: the walk must not plant a mount inside a dependency tree.
    await mkdir(join(root, "node_modules", "pkg", "node_modules"), { recursive: true });
    expect(await modulesDirs(root)).toEqual(["", "_apps/web", "_libs/ui"]);
});
