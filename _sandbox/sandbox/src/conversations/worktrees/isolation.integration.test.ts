import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { basename, join } from "node:path";
import { HISTORY_ROOT, STATE_DIR, WORKSPACE_ROOT } from "@intentic/constants";
import { MIRRORED_DIRS } from "@intentic/constants/mirror-roots";
import { repoRoot } from "@intentic/constants/node";
import { SHARED_STATE_PATHS } from "@intentic/sandbox-contract";
import { shellQuote } from "@intentic/sandbox-run/quote";
import type { Logger } from "pino";
import { unstubbed } from "@intentic/testing";
import { requires } from "@intentic/testing/requires";
import {
    ANCHOR_READY,
    createTurnIsolation,
    fromWorktree,
    hiddenIn,
    inWorktree,
    type IsolationPlan,
    fstabOf,
    isolationScript,
    MAIN_MOUNT,
    type MountEntry,
    type MountFacts,
    mountPointsOf,
    mountTable,
    prepareMountView,
    mirroredDirs,
    nsenterArgv,
    nsenterPrefix,
} from "./isolation.js";
import { sessionsDir } from "../../sessions/session-store.js";

// Pins the mount plan and path translation, not the real namespace (CAP_SYS_ADMIN is not guaranteed here); a wrong
// order fails silently at runtime, which is what this catches instead.

const tempDirs: string[] = [];
afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

const plan: IsolationPlan = {
    worktree: `${HISTORY_ROOT}/worktrees/abc`,
    root: WORKSPACE_ROOT,
    mirrors: ["node_modules", "_apps/web/node_modules", "_apps/web/dist"],
    overlays: `${HISTORY_ROOT}/overlays/abc`,
    fence: undefined,
};

// The same conversation, started by someone holding areas: its checkout is a sparse one (worktree-cone.ts) and its
// sandbox has to be what makes that cut true. Read from the real placement rather than written out, so the policy is
// pinned once, where it is decided.
const isolation = createTurnIsolation({
    root: WORKSPACE_ROOT,
    historyRoot: HISTORY_ROOT,
    logger: unstubbed<Logger>("logger", { warn: () => {} }),
});

const FACTS: MountFacts = { shelf: false, store: false, volatile: true };
const FSTAB = `${HISTORY_ROOT}/overlays/abc/.mounts/t.fstab`;
const targetsOf = (table: readonly MountEntry[]): string[] => table.map((entry) => entry.target);

test("the namespace is made private before anything is mounted, and then mounted by one mount -a", () => {
    const lines = isolationScript(FSTAB).split("\n");
    expect(lines[0]).toBe("set -e");
    // Otherwise an 'isolated' turn would rewrite the daemon's own /work.
    expect(lines[1]).toBe("mount --make-rprivate /");
    // One process for every mount, reporting each as it goes: the progress the holder's readiness reads.
    expect(lines[2]).toBe(`mount -a --fstab ${shellQuote(FSTAB)} -v`);
    expect(lines.filter((line) => line.startsWith("mount ") || line.startsWith("mkdir "))).toHaveLength(2);
});

test("the main root is bound aside before the worktree shadows it", () => {
    const table = mountTable(plan, FACTS);
    expect(table[0]).toEqual({ source: WORKSPACE_ROOT, target: MAIN_MOUNT, type: "none", options: "bind" });
    expect(table[1]).toEqual({ source: `${HISTORY_ROOT}/worktrees/abc`, target: WORKSPACE_ROOT, type: "none", options: "bind" });
});

test("the main tree's package store is bound back in, only where one exists, so installs share one cache", () => {
    const store = { source: `${MAIN_MOUNT}/.pnpm-store`, target: `${WORKSPACE_ROOT}/.pnpm-store`, type: "none", options: "bind" } satisfies MountEntry;
    expect(mountTable(plan, FACTS)).not.toContainEqual(store);
    const table = mountTable(plan, { ...FACTS, store: true });
    expect(table).toContainEqual(store);
    // Bound before the overlays, which read from the same aside mount.
    expect(targetsOf(table).indexOf(store.target)).toBeLessThan(table.findIndex((entry) => entry.type === "overlay"));
    expect(mountPointsOf(plan, { shelf: false, store: true })).toContain(`${HISTORY_ROOT}/worktrees/abc/.pnpm-store`);
    expect(mountPointsOf(plan, { shelf: false, store: false })).not.toContain(`${HISTORY_ROOT}/worktrees/abc/.pnpm-store`);
});

test("shared state is re-bound from the aside mount, not from the shadowed path", () => {
    const table = mountTable(plan, FACTS);
    // From /work this would silently mount the worktree's empty copy; a bind, not overlay, reaches the daemon.
    const shared = SHARED_STATE_PATHS.map((path) => path.replace(/\/$/, ""));
    expect(shared).toContain(".intentic/records");
    expect(shared).toContain(".intentic/config/docs");
    const points = mountPointsOf(plan, FACTS);
    for (const rel of shared) {
        expect(table).toContainEqual({ source: `${MAIN_MOUNT}/${rel}`, target: `${WORKSPACE_ROOT}/${rel}`, type: "none", options: "bind" });
        // Both sides may not exist yet: the daemon makes them, the main tree's and the worktree's, before the holder starts.
        expect(points).toContain(`${WORKSPACE_ROOT}/${rel}`);
        expect(points).toContain(`${HISTORY_ROOT}/worktrees/abc/${rel}`);
    }
    // The tracked slice is the worktree's own; binding over it would put the owner's config outside `land`.
    expect(targetsOf(table)).not.toContain(`${WORKSPACE_ROOT}/.intentic`);
    expect(targetsOf(table)).not.toContain(`${WORKSPACE_ROOT}/.intentic/config`);
});

// A fenced turn runs in a sandbox (turn-sandbox.ts) rather than this script, so the script itself has no fenced
// branch; what the plan carries for the sandbox is pinned here, where the plan is made.
test("a fenced conversation's placement names its fence, its own session store, every repository pointer, and what to cover", async () => {
    const worktree = await mkdtemp(join(tmpdir(), "fenced-wt-"));
    tempDirs.push(worktree);
    await writeFile(join(worktree, ".git"), "gitdir: /history/gits/root/worktrees/x\n");
    await mkdir(join(worktree, "support", "docs"), { recursive: true });
    await mkdir(join(worktree, "intent"), { recursive: true });
    await writeFile(join(worktree, "intent", ".git"), "gitdir: /history/gits/intent/worktrees/x\n");
    // A dependency tree is never walked into: a package there carrying its own `.git` is not the checkout's.
    await mkdir(join(worktree, "node_modules", "pkg"), { recursive: true });
    await writeFile(join(worktree, "node_modules", "pkg", ".git"), "");
    const placed = await isolation.planFor(worktree, ["support/docs/"]);
    expect(placed.fence?.folders).toEqual(["support/docs"]);
    expect(placed.fence?.sessions).toBe(sessionsDir(HISTORY_ROOT, basename(worktree)));
    expect(placed.fence?.gitPointers).toEqual(["", "intent"]);
    // Neither inside the fence nor on the way to it: covered in the sandbox, whatever put them there.
    expect(placed.fence?.hidden).toEqual(["intent", "node_modules"]);
    expect((await isolation.planFor(worktree, undefined)).fence).toBeUndefined();
});

// A checkout that failed to narrow, or kept untracked work in a folder its area has since dropped, holds more than the
// fence; the walk finds it by the fence alone, going down only the paths that lead to the fence's folders.
test("whatever a fenced checkout holds outside its fence is listed for covering, however it got there", async () => {
    const worktree = await mkdtemp(join(tmpdir(), "fenced-wt-"));
    tempDirs.push(worktree);
    for (const dir of ["support/web/src", "support/billing", "finance/q3", `${STATE_DIR}/config`, "refs/sdk", "refs/private"]) {
        await mkdir(join(worktree, dir), { recursive: true });
    }
    await writeFile(join(worktree, "README.md"), "kept by cone mode");
    await writeFile(join(worktree, "finance", "q3", "numbers.csv"), "left behind");
    expect(await hiddenIn(worktree, ["support/web", "refs/sdk"])).toEqual([".intentic", "finance", "refs/private", "support/billing"]);
    // A fence holding the whole workspace covers nothing.
    expect(await hiddenIn(worktree, [""])).toEqual([]);
});

test("a fenced checkout gets the main tree's mirrors only where it has the parent directory", async () => {
    const main = await mkdtemp(join(tmpdir(), "fenced-main-"));
    const worktree = await mkdtemp(join(tmpdir(), "fenced-wt-"));
    tempDirs.push(main, worktree);
    for (const dir of ["node_modules", "support/web/dist", "finance/app/dist"]) {
        await mkdir(join(main, dir), { recursive: true });
    }
    // The sparse checkout holds `support/web` and not `finance`: finance's build output must not come back as a mirror.
    await mkdir(join(worktree, "support", "web"), { recursive: true });
    const scoped = createTurnIsolation({ root: main, historyRoot: HISTORY_ROOT, logger: unstubbed<Logger>("logger", { warn: () => {} }) });
    expect((await scoped.planFor(worktree, ["support/web"])).mirrors).toEqual(["node_modules", "support/web/dist"]);
    // Unfenced, every mirror goes in as before: the checkout is whole there.
    expect((await scoped.planFor(worktree, undefined)).mirrors).toEqual(["node_modules", "finance/app/dist", "support/web/dist"]);
});

// The checkout keeps `project` on the way down to `project/support`, and `project/dist` is built from every sibling the
// fence leaves out; its dependencies are what `project/support` resolves through, so those still come in.
test("a fenced checkout gets build output only inside its fence, and dependencies on the way down to it", async () => {
    const main = await mkdtemp(join(tmpdir(), "fenced-main-"));
    const worktree = await mkdtemp(join(tmpdir(), "fenced-wt-"));
    tempDirs.push(main, worktree);
    for (const dir of ["dist", "node_modules", "project/dist", "project/node_modules", "project/support/dist", "project/secret/dist"]) {
        await mkdir(join(main, dir), { recursive: true });
    }
    await mkdir(join(worktree, "project", "support"), { recursive: true });
    const scoped = createTurnIsolation({ root: main, historyRoot: HISTORY_ROOT, logger: unstubbed<Logger>("logger", { warn: () => {} }) });
    expect((await scoped.planFor(worktree, ["project/support"])).mirrors).toEqual(["node_modules", "project/node_modules", "project/support/dist"]);
});

test("the reference shelf comes back into the worktree, read-only, and only when the workspace has one", () => {
    const shelf = { source: `${MAIN_MOUNT}/refs`, target: `${WORKSPACE_ROOT}/refs`, type: "none", options: "bind,ro" } satisfies MountEntry;
    // Without this, a turn comparing against a ref finds no /work/refs at all; libmount turns `bind,ro` into the bind
    // and the read-only remount the bind alone ignores.
    expect(mountTable(plan, { ...FACTS, shelf: true })).toContainEqual(shelf);
    // Most workspaces have no shelf, and mounting one that is not there would fail the whole setup.
    expect(mountTable(plan, FACTS)).not.toContainEqual(shelf);
    // A mirror on the shelf is mounted over the main checkout's copy, which exists: nothing is made in the worktree.
    const withShelfMirror = { ...plan, mirrors: [...plan.mirrors, "refs/sdk/node_modules"] };
    expect(mountPointsOf(withShelfMirror, { shelf: true, store: false })).not.toContain(`${HISTORY_ROOT}/worktrees/abc/refs/sdk/node_modules`);
    expect(mountPointsOf(withShelfMirror, { shelf: true, store: false })).toContain(`${HISTORY_ROOT}/worktrees/abc/_apps/web/node_modules`);
});

test("a mirrored tree is a volatile overlay over the main checkout, never a writable bind onto it", () => {
    const table = mountTable(plan, FACTS);
    // pnpm hardlinks sources into node_modules; a writable bind would let a write rewrite the main checkout.
    expect(table).toContainEqual({
        source: "intentic-modules",
        target: `${WORKSPACE_ROOT}/node_modules`,
        type: "overlay",
        options: `lowerdir=${MAIN_MOUNT}/node_modules,upperdir=/history/overlays/abc/node_modules/upper,workdir=/history/overlays/abc/node_modules/work,volatile`,
    });
    // One overlay layer per package path; a nested tree must not share or nest inside the root's layer.
    expect(table).toContainEqual({
        source: "intentic-modules",
        target: `${WORKSPACE_ROOT}/_apps/web/node_modules`,
        type: "overlay",
        options: `lowerdir=${MAIN_MOUNT}/_apps/web/node_modules,upperdir=/history/overlays/abc/_apps%2Fweb%2Fnode_modules/upper,workdir=/history/overlays/abc/_apps%2Fweb%2Fnode_modules/work,volatile`,
    });
    // No leftover bind: a single one would reopen the whole hole.
    expect(table.filter((entry) => entry.source === `${MAIN_MOUNT}/node_modules`)).toEqual([]);
    // Build output uses the same mechanism, or cross-package imports fail to resolve at collection.
    expect(targetsOf(table)).toContain(`${WORKSPACE_ROOT}/_apps/web/dist`);
    // A kernel without volatile overlays mounts them as before.
    expect(mountTable(plan, { ...FACTS, volatile: false }).filter((entry) => entry.options.endsWith(",volatile"))).toEqual([]);
    // The mount points are the worktree's own dirs, made before the holder starts.
    expect(mountPointsOf(plan, FACTS)).toContain(`${HISTORY_ROOT}/worktrees/abc/node_modules`);
});

test("a path that would corrupt the overlay option string is refused rather than mounted wrong", () => {
    // The kernel splits overlay options on `,`/`:`; either character in a path would mount the wrong thing silently.
    expect(() => mountTable({ ...plan, overlays: "/history/overlays/a,b" }, FACTS)).toThrow(/cannot contain/);
});

test("the mount table spells whitespace and backslashes the way fstab reads them back", () => {
    const fstab = fstabOf([{ source: "/a b", target: "/c\td\\e", type: "none", options: "bind" }]);
    expect(fstab).toBe("/a\\040b /c\\011d\\134e none bind 0 0\n");
});

test("the anchor announces readiness only after the mounts, then becomes the namespace's inhabitant", () => {
    const lines = isolationScript(FSTAB).split("\n");
    // Readiness comes after the mount, so a caller starting on it never finds a half-built namespace.
    expect(lines.at(-2)).toBe(`echo ${ANCHOR_READY}`);
    expect(lines.at(-1)).toBe("exec sleep infinity");
    expect(lines.findIndex((line) => line.startsWith("mount -a"))).toBeLessThan(lines.length - 2);
    // `exec`, so the sleep is the pid nsenter targets, not a shell waiting on it under a different one.
    expect(lines.at(-1)?.startsWith("exec ")).toBe(true);
});

// `--wd` resolves before setns and lands on the daemon's own /work, unreachable inside the namespace (this killed Codex
// at startup); `--wdns` resolves after, so /work means the worktree.
test("entrants join the anchor's namespace by pid and start at the workspace root AS THE NAMESPACE SEES IT", () => {
    const { command, args } = nsenterArgv(4321, WORKSPACE_ROOT, "/usr/bin/claude", ["--flag", "value"]);
    expect(command).toBe("nsenter");
    expect(args).toEqual([
        "--mount=/proc/4321/ns/mnt",
        "--wdns=/work",
        "--",
        "env",
        "-u",
        "PWD",
        "-u",
        "OLDPWD",
        "/usr/bin/claude",
        "--flag",
        "value",
    ]);
    expect(args).not.toContain(`--wd=${WORKSPACE_ROOT}`);
});

// `--wdns` moves the kernel's cwd, but a stale `$PWD` from the daemon still names the old path, and bash trusts it over
// getcwd(); unsetting it forces the real cwd instead.
test("an entrant cannot bring the daemon's own PWD in with it", () => {
    const { args } = nsenterArgv(4321, WORKSPACE_ROOT, "node", []);
    expect(args.slice(args.indexOf("--") + 1)).toEqual(["env", "-u", "PWD", "-u", "OLDPWD", "node"]);
    expect(nsenterPrefix(7, "/work")).toContain("env -u PWD -u OLDPWD");
});

test("the shell-string form quotes its working dir so a path with a space cannot split the command", () => {
    expect(nsenterPrefix(7, "/work dir")).toBe(`nsenter --mount=/proc/7/ns/mnt --wdns='/work dir' -- env -u PWD -u OLDPWD `);
});

test("a path the agent reports is translated back to the worktree for the daemon", () => {
    expect(inWorktree("/work/intentic/src/x.ts", plan)).toBe("/history/worktrees/abc/intentic/src/x.ts");
    // Outside the root, the same file in both namespaces.
    expect(inWorktree("/root/.claude/memory/x.md", plan)).toBe("/root/.claude/memory/x.md");
    // Not isolated: the path is left untouched.
    expect(inWorktree("/work/intentic/src/x.ts", undefined)).toBe("/work/intentic/src/x.ts");
});

// The same mapping backwards, so a daemon-side answer quoted back to the agent never names the real worktree path
// directly, which would read as an instruction to leave the namespace.
test("a path the daemon reports is translated back to the name the agent uses", () => {
    expect(fromWorktree("/history/worktrees/abc/intentic/src/x.ts", plan)).toBe("/work/intentic/src/x.ts");
    expect(fromWorktree("/history/worktrees/abc", plan)).toBe("/work");
    // Already in the agent's naming, outside the root, or not isolated: left as is.
    expect(fromWorktree("/work/intentic/src/x.ts", plan)).toBe("/work/intentic/src/x.ts");
    expect(fromWorktree("/root/.claude/memory/x.md", plan)).toBe("/root/.claude/memory/x.md");
    expect(fromWorktree("/history/worktrees/abc/intentic/src/x.ts", undefined)).toBe("/history/worktrees/abc/intentic/src/x.ts");
    // A sibling worktree sharing a name prefix is still a different conversation's tree.
    expect(fromWorktree("/history/worktrees/abcd/intentic/src/x.ts", plan)).toBe("/history/worktrees/abcd/intentic/src/x.ts");
});

test("translating a worktree path out and back is the path it started as", () => {
    expect(fromWorktree(inWorktree("/work/intentic/src/x.ts", plan), plan)).toBe("/work/intentic/src/x.ts");
});

test("re-bound subtrees resolve to the main tree in both namespaces and are never translated", () => {
    // Translating these would send the daemon looking in a worktree with no such file.
    expect(inWorktree("/work/.intentic/records/artifacts/attachments/a.png", plan)).toBe("/work/.intentic/records/artifacts/attachments/a.png");
    expect(inWorktree("/work/_apps/web/node_modules/vue/index.js", plan)).toBe("/work/_apps/web/node_modules/vue/index.js");
    // The staged docs tree is the untracked entry inside the tracked group, shared the same way.
    expect(inWorktree("/work/.intentic/config/docs/root/repo.json", plan)).toBe("/work/.intentic/config/docs/root/repo.json");
    // A path that only starts like a shared one is still worktree content.
    expect(inWorktree("/work/.intentic-notes/x.md", plan)).toBe("/history/worktrees/abc/.intentic-notes/x.md");
});

test("the tracked state slice is the worktree's own, so it moves with the root like any other file", () => {
    // Left untranslated, the edit reaches the live tree with no branch, no land and no author.
    expect(inWorktree("/work/.intentic/config/settings.json", plan)).toBe("/history/worktrees/abc/.intentic/config/settings.json");
    expect(inWorktree("/work/.intentic/config/approvals/post-1.json", plan)).toBe("/history/worktrees/abc/.intentic/config/approvals/post-1.json");
    expect(inWorktree("/work/.intentic/config", plan)).toBe("/history/worktrees/abc/.intentic/config");
    expect(fromWorktree("/history/worktrees/abc/.intentic/config/settings.json", plan)).toBe("/work/.intentic/config/settings.json");
});

// A worktree of `root`; tracked source only, which is why the mirrored dirs are missing from it.
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
    // Build output is untracked the same way an install is; a sibling package's import resolves through it.
    await mkdir(join(root, "_libs", "ui", "dist"), { recursive: true });
    // Never descended into: the walk must not plant a mount inside a dependency tree.
    await mkdir(join(root, "node_modules", "pkg", "node_modules"), { recursive: true });
    // A build cache is deliberately not mirrored: main's tsbuildinfo would wrongly claim to cover it.
    await mkdir(join(root, "_libs", "ui", ".cache"), { recursive: true });

    expect(await mirroredDirs(root, await checkout(), { intoNestedRepos: true })).toEqual([
        "node_modules",
        "_apps/web/node_modules",
        "_libs/ui/dist",
        "_libs/ui/node_modules",
    ]);
});

test("a dir the checkout fills is never mirrored: a tracked build output stays the agent's own", async () => {
    const root = await mkdtemp(join(tmpdir(), "isolation-"));
    tempDirs.push(root);
    await mkdir(join(root, "_libs", "ui", "dist"), { recursive: true });
    await mkdir(join(root, "_libs", "ui", "node_modules"), { recursive: true });

    // The repo tracks this dist already; mirroring it would hide the files the branch exists to change.
    const worktree = await checkout();
    await mkdir(join(worktree, "_libs", "ui", "dist"), { recursive: true });
    await writeFile(join(worktree, "_libs", "ui", "dist", "index.js"), "the agent's own\n");

    expect(await mirroredDirs(root, worktree, { intoNestedRepos: true })).toEqual(["_libs/ui/node_modules"]);
});

// Every name in MIRRORED_DIRS becomes an overlay, and `_tools/checks/mirror-roots.mjs` refuses a main-tree command that
// replaces (not empties) any of them; derived from the same set, so a name missed here is a directory nothing protects.
test("every name the shared set carries is discovered as a mirror, and nothing else is", async () => {
    const root = await mkdtemp(join(tmpdir(), "isolation-"));
    tempDirs.push(root);
    for (const dir of MIRRORED_DIRS) {
        await mkdir(join(root, "_libs", "ui", dir), { recursive: true });
    }
    // Also untracked, but deliberately not mirrored, for the same tsbuildinfo reason as a cache.
    await mkdir(join(root, "_libs", "ui", ".cache"), { recursive: true });

    expect(await mirroredDirs(root, await checkout(), { intoNestedRepos: true })).toEqual(
        [...MIRRORED_DIRS].toSorted().map((dir) => `_libs/ui/${dir}`),
    );
});

test("a nested repo's dirs belong to its own worktree, not the parent's", async () => {
    const root = await mkdtemp(join(tmpdir(), "isolation-"));
    tempDirs.push(root);
    await mkdir(join(root, "node_modules"), { recursive: true });
    await mkdir(join(root, "intent", ".git"), { recursive: true });
    await mkdir(join(root, "intent", "node_modules"), { recursive: true });

    const worktree = await checkout();
    // The plan spans the whole workspace; a nested worktree wants both its own dirs and the parent's.
    expect(await mirroredDirs(root, worktree, { intoNestedRepos: true })).toEqual(["node_modules", "intent/node_modules"]);
    // The symlink mirror runs per repo; including nested dirs here would plant the link inside the parent's checkout.
    expect(await mirroredDirs(root, worktree, { intoNestedRepos: false })).toEqual(["node_modules"]);
});

// Verified against a real overlay: emptying a mirror root's lowerdir is safe, replacing it is fatal and unrecoverable
// in the namespace. Needs CAP_SYS_ADMIN (`overlay` below), guarded there by mirror-roots.mjs.
// One shell program, since the mount only exists inside the namespace that creates it: build the overlay, then run the
// caller's assertions.
const overlayShell = (dir: string, trailer: string): string =>
    [
        "set -e",
        `mount -t overlay probe -o ${shellQuote(`lowerdir=${dir}/lower/dist,upperdir=${dir}/upper,workdir=${dir}/work`)} ${shellQuote(`${dir}/merged`)}`,
        trailer,
    ].join("\n");

const overlayScratch = (): string | undefined => {
    if (!existsSync(HISTORY_ROOT)) {
        return undefined;
    }
    const dir = mkdtempSync(join(HISTORY_ROOT, ".overlay-probe-"));
    for (const part of ["lower/dist", "upper", "work", "merged"]) {
        mkdirSync(join(dir, part), { recursive: true });
    }
    // The mount is the probe: seccomp can still refuse it even with the capability present.
    const probe = spawnSync("unshare", ["--mount", "--propagation", "private", "sh", "-c", overlayShell(dir, "true")], { timeout: 10_000 });
    if (probe.status === 0) {
        return dir;
    }
    // Reclaimed here, not by `afterEach`, which only owns a scratch a test actually claimed.
    rmSync(dir, { recursive: true, force: true });
    return undefined;
};

const OVERLAY_SCRATCH = overlayScratch();
// CI's verify-machine job runs it, in a privileged container with a tmpfs at /history (ci.yml).
const overlay = requires(OVERLAY_SCRATCH !== undefined, `CAP_SYS_ADMIN (an overlay mount) and the history volume at ${HISTORY_ROOT}`, {
    lane: "machine",
});
const listing = (output: string, label: string): string[] =>
    (output.split("\n").find((line) => line.startsWith(`${label}:`)) ?? "")
        .slice(label.length + 1)
        .split(" ")
        .filter(Boolean)
        .toSorted();

test.skipIf(!overlay.runs)(overlay.title("emptying a mirror root keeps the turn's view of it; replacing it empties the turn's view"), () => {
    const dir = OVERLAY_SCRATCH as string;
    tempDirs.push(dir);
    const lower = `${dir}/lower/dist`;
    const merged = `${dir}/merged`;
    const clean = join(repoRoot(import.meta.url), "_tools/scripts/build/clean-outputs.mjs");
    const result = spawnSync(
        "unshare",
        [
            "--mount",
            "--propagation",
            "private",
            "sh",
            "-c",
            overlayShell(
                dir,
                [
                    // The turn's own write, landing in its upper layer.
                    `printf turn > ${shellQuote(`${merged}/turn.js`)}`,
                    // The sanctioned way to clear a dist: the same script every build in this repo now calls.
                    `node ${shellQuote(clean)} ${shellQuote(lower)} > /dev/null`,
                    `printf main > ${shellQuote(`${lower}/main.js`)}`,
                    `echo "emptied: $(ls ${shellQuote(merged)} | tr '\\n' ' ')"`,
                    // The old way: gives the path a new inode.
                    `rm -rf ${shellQuote(lower)} && mkdir ${shellQuote(lower)} && printf main > ${shellQuote(`${lower}/main.js`)}`,
                    `echo "replaced: $(ls ${shellQuote(merged)} | tr '\\n' ' ')"`,
                    // The upper layer is untouched either way; only readdir stops naming the file.
                    `echo "stat: $(cat ${shellQuote(`${merged}/turn.js`)} 2>&1)"`,
                ].join("\n"),
            ),
        ],
        { encoding: "utf8", timeout: 30_000 },
    );
    expect(result.stderr).toBe("");
    // Emptied in place: the lower's new file and the turn's own both survive.
    expect(listing(result.stdout, "emptied")).toEqual(["main.js", "turn.js"]);
    // Replaced: nothing at all survives, not even the turn's own file. This is the outage.
    expect(listing(result.stdout, "replaced")).toEqual([]);
    // A readdir failure, not data loss: the file still opens by name, which is why TS6307 was the symptom.
    expect(result.stdout).toContain("stat: turn");
});

test.skipIf(!overlay.runs)(
    overlay.title("a prepared view mounts in one pass: reads come from main, writes land in the layer, a volatile layer mounts again within its boot"),
    async () => {
        const scratch = mkdtempSync(join(HISTORY_ROOT, ".mount-view-"));
        tempDirs.push(scratch);
        const main = join(scratch, "main");
        const worktree = join(scratch, "wt");
        const overlays = join(scratch, "overlays");
        mkdirSync(join(main, "node_modules", "pkg"), { recursive: true });
        writeFileSync(join(main, "node_modules", "pkg", "index.js"), "from-main");
        mkdirSync(join(main, "refs", "sdk"), { recursive: true });
        mkdirSync(worktree, { recursive: true });
        const scratchPlan: IsolationPlan = { worktree, root: main, mirrors: ["node_modules"], overlays, fence: undefined };
        const mounted = async () => {
            const view = await prepareMountView(scratchPlan);
            const trailer = [
                `echo ${ANCHOR_READY}`,
                `echo "read: $(cat ${shellQuote(`${main}/node_modules/pkg/index.js`)})"`,
                `echo "seen: $(ls ${shellQuote(`${main}/node_modules`)} | tr '\\n' ' ')"`,
                `printf turn > ${shellQuote(`${main}/node_modules/turn.js`)}`,
                `touch ${shellQuote(`${main}/refs/sdk/x`)} 2>/dev/null && echo "shelf: writable" || echo "shelf: read-only"`,
            ].join("\n");
            try {
                return spawnSync("unshare", ["--mount", "--propagation", "private", "sh", "-c", isolationScript(view.fstab, trailer)], { encoding: "utf8", timeout: 30_000 });
            } finally {
                await view.release();
            }
        };
        const first = await mounted();
        expect(first.stderr).toBe("");
        expect(first.status).toBe(0);
        const lines = first.stdout.split("\n");
        // `mount -v` reports each mount before readiness: the progress the holder's deadline counts.
        const ready = lines.indexOf(ANCHOR_READY);
        expect(lines.slice(0, ready).filter((line) => line.endsWith("successfully mounted")).length).toBeGreaterThan(3);
        expect(first.stdout).toContain("read: from-main");
        expect(first.stdout).toContain("shelf: read-only");
        // The turn's write is the layer's, never the main checkout's.
        expect(existsSync(join(main, "node_modules", "turn.js"))).toBe(false);
        expect(existsSync(join(overlays, "node_modules", "upper", "turn.js"))).toBe(true);
        // The table is gone once the holder has read it.
        expect(existsSync(join(overlays, ".mounts")) ? readdirSync(join(overlays, ".mounts")) : []).toEqual([]);

        // Mounted again in the same boot: the kernel's volatile marker is cleared and the layer kept.
        const again = await mounted();
        expect(again.status).toBe(0);
        expect(again.stdout).toContain("turn.js");

        // A layer an earlier boot last mounted volatile may hold writes that never reached the disk: it starts empty.
        writeFileSync(join(overlays, "node_modules", "volatile-boot"), "an-earlier-boot\n");
        const rebooted = await mounted();
        expect(rebooted.status).toBe(0);
        expect(listing(rebooted.stdout, "seen")).toEqual(["pkg"]);
    },
);
