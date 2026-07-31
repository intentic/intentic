import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, expect, test } from "vitest";
import { ANCHOR_READY, inWorktree, type IsolationPlan, isolationScript, MAIN_MOUNT, mirroredDirs, nsenterArgv, nsenterPrefix } from "./isolation.js";

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

const plan: IsolationPlan = {
    worktree: "/history/worktrees/abc",
    root: "/work",
    mirrors: ["node_modules", "_apps/web/node_modules", "_apps/web/dist"],
    overlays: "/history/overlays/abc",
};

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

test("shared state is re-bound from the aside mount, not from the shadowed path", () => {
    const script = isolationScript(plan);
    // Sourcing this from /work would name the worktree's own (empty) copy — the mount would succeed and the
    // agent would silently lose the transcript store. A BIND, not an overlay: a transcript written here has
    // to reach the daemon.
    expect(script).toContain(`mount --bind '${MAIN_MOUNT}/.intentic' '/work/.intentic'`);
    // A fresh checkout has no mount point for an untracked dir.
    expect(script).toContain(`mkdir -p '/work/.intentic'`);
});

test("the reference shelf comes back into the worktree, read-only, and only when the workspace has one", () => {
    const script = isolationScript(plan);
    // Without this a turn asked to "compare against refs/nimbalyst" finds no /work/refs at all and spends a
    // call rediscovering that the shelf only exists at MAIN_MOUNT.
    expect(script).toContain(`if [ -d '${MAIN_MOUNT}/refs' ]; then`);
    expect(script).toContain(`mount --bind '${MAIN_MOUNT}/refs' '/work/refs'`);
    // `ro` is ignored on the bind itself — it takes only on the remount, and the shelf is read-only by contract.
    expect(script).toContain(`mount -o remount,bind,ro '/work/refs'`);
    // Guarded, because most workspaces have no shelf and `set -e` would kill the namespace over its absence.
    expect(script).toContain(`fi`);
});

test("a mirrored tree is an overlay over the main checkout, never a writable bind onto it", () => {
    const script = isolationScript(plan);
    // The whole point: pnpm hardlinks workspace sources into node_modules, so a WRITABLE bind here let a
    // write through the node_modules name rewrite the main checkout's tracked file. Reads still come from
    // the main tree (lowerdir); writes land in this turn's own upper layer.
    expect(script).toContain(
        `mount -t overlay intentic-modules -o 'lowerdir=${MAIN_MOUNT}/node_modules,upperdir=/history/overlays/abc/node_modules/upper,workdir=/history/overlays/abc/node_modules/work' '/work/node_modules'`,
    );
    // One layer per mount, keyed by the package path — a nested tree must not share (or nest inside) the
    // root's layer, and upper/work must be siblings.
    expect(script).toContain(
        `mount -t overlay intentic-modules -o 'lowerdir=${MAIN_MOUNT}/_apps/web/node_modules,upperdir=/history/overlays/abc/_apps%2Fweb%2Fnode_modules/upper,workdir=/history/overlays/abc/_apps%2Fweb%2Fnode_modules/work' '/work/_apps/web/node_modules'`,
    );
    // Both layer dirs have to exist before the mount that names them.
    expect(script).toContain(`mkdir -p '/work/node_modules' '/history/overlays/abc/node_modules/upper' '/history/overlays/abc/node_modules/work'`);
    // Nothing binds a dependency tree any more — a single leftover bind is the whole hole reopened.
    expect(script).not.toContain(`mount --bind '${MAIN_MOUNT}/node_modules'`);
    // Build output rides the same mechanism: without it a worktree resolves third-party imports but not its
    // own siblings', and every suite that crosses a package boundary dies at collection.
    expect(script).toContain(
        `mount -t overlay intentic-modules -o 'lowerdir=${MAIN_MOUNT}/_apps/web/dist,upperdir=/history/overlays/abc/_apps%2Fweb%2Fdist/upper,workdir=/history/overlays/abc/_apps%2Fweb%2Fdist/work' '/work/_apps/web/dist'`,
    );
});

test("a path that would corrupt the overlay option string is refused rather than mounted wrong", () => {
    // The kernel splits these options on "," and ":", so a path carrying either would mount something other
    // than what was asked for — which is exactly the silent-wrong-tree failure this module exists to prevent.
    expect(() => isolationScript({ ...plan, overlays: "/history/overlays/a,b" })).toThrow(/cannot contain/);
});

test("the anchor announces readiness only after the mounts, then becomes the namespace's inhabitant", () => {
    const lines = isolationScript(plan).split("\n");
    // Readiness AFTER the last mount: a caller that starts work on the announcement must never find a
    // half-built namespace writing through to the shared tree.
    expect(lines.at(-2)).toBe(`echo ${ANCHOR_READY}`);
    expect(lines.at(-1)).toBe("exec sleep infinity");
    expect(lines.findLastIndex((line) => line.startsWith("mount -t overlay"))).toBeLessThan(lines.length - 2);
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

// A checked-out worktree of `root`: tracked source only, which is precisely why the dirs below are missing
// from it and have to be mirrored.
const checkout = async (): Promise<string> => {
    const worktree = await mkdtemp(join(tmpdir(), "isolation-wt-"));
    tempDirs.push(worktree);
    for (const pkg of ["_apps/web", "_libs/ui"]) {
        await mkdir(join(worktree, pkg), { recursive: true });
    }
    return worktree;
};

test("dependency and build-output dirs are discovered shallowest-first so a parent never shadows a child", async () => {
    const root = await mkdtemp(join(tmpdir(), "isolation-"));
    tempDirs.push(root);
    await mkdir(join(root, "node_modules"), { recursive: true });
    await mkdir(join(root, "_apps", "web", "node_modules"), { recursive: true });
    await mkdir(join(root, "_libs", "ui", "node_modules"), { recursive: true });
    // Build output is untracked the same way an install is, and a sibling package's import resolves through it.
    await mkdir(join(root, "_libs", "ui", "dist"), { recursive: true });
    // Never descended into: the walk must not plant a mount inside a dependency tree.
    await mkdir(join(root, "node_modules", "pkg", "node_modules"), { recursive: true });
    // A build CACHE is deliberately not mirrored — main's tsbuildinfo would tell the turn's incremental build
    // that the mirrored dist already covers sources the turn has since changed.
    await mkdir(join(root, "_libs", "ui", ".cache"), { recursive: true });

    expect(await mirroredDirs(root, await checkout(root), { intoNestedRepos: true })).toEqual([
        "node_modules",
        "_apps/web/node_modules",
        "_libs/ui/dist",
        "_libs/ui/node_modules",
    ]);
});

test("a dir the checkout fills is never mirrored — a tracked build output stays the agent's own", async () => {
    const root = await mkdtemp(join(tmpdir(), "isolation-"));
    tempDirs.push(root);
    await mkdir(join(root, "_libs", "ui", "dist"), { recursive: true });
    await mkdir(join(root, "_libs", "ui", "node_modules"), { recursive: true });

    // The repo TRACKS its dist, so the checkout carries it. Mounting the main tree's over it would hide the
    // very files the agent's branch exists to change.
    const worktree = await checkout(root);
    await mkdir(join(worktree, "_libs", "ui", "dist"), { recursive: true });
    await writeFile(join(worktree, "_libs", "ui", "dist", "index.js"), "the agent's own\n");

    expect(await mirroredDirs(root, worktree, { intoNestedRepos: true })).toEqual(["_libs/ui/node_modules"]);
});

test("a nested repo's dirs belong to its own worktree, not the parent's", async () => {
    const root = await mkdtemp(join(tmpdir(), "isolation-"));
    tempDirs.push(root);
    await mkdir(join(root, "node_modules"), { recursive: true });
    await mkdir(join(root, "intent", ".git"), { recursive: true });
    await mkdir(join(root, "intent", "node_modules"), { recursive: true });

    const worktree = await checkout(root);
    // The PLAN spans the workspace: each nested worktree is mounted under the same root, so it wants both.
    expect(await mirroredDirs(root, worktree, { intoNestedRepos: true })).toEqual(["node_modules", "intent/node_modules"]);
    // The symlink mirror runs per repo, and planting `intent/node_modules` from here would put the nested
    // repo's link inside the PARENT's checkout.
    expect(await mirroredDirs(root, worktree, { intoNestedRepos: false })).toEqual(["node_modules"]);
});
