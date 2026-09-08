import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { HISTORY_ROOT, WORKSPACE_ROOT } from "@intentic/constants";
import { MIRRORED_DIRS } from "@intentic/constants/mirror-roots";
import { repoRoot } from "@intentic/constants/node";
import { SHARED_STATE_PATHS } from "@intentic/sandbox-contract";
import { shellQuote } from "@intentic/sandbox-run/quote";
import { afterEach, expect, test } from "vitest";
import {
    ANCHOR_READY,
    fromWorktree,
    inWorktree,
    type IsolationPlan,
    isolationScript,
    MAIN_MOUNT,
    mirroredDirs,
    nsenterArgv,
    nsenterPrefix,
} from "./isolation.js";

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
};

test("the namespace is made private before anything is mounted", () => {
    const lines = isolationScript(plan).split("\n");
    expect(lines[0]).toBe("set -e");
    expect(lines[1]).toBe("mount --make-rprivate /");
    // Otherwise an 'isolated' turn would rewrite the daemon's own /work.
    expect(lines.findIndex((line) => line.startsWith("mount --bind"))).toBeGreaterThan(1);
});

test("the main root is bound aside before the worktree shadows it", () => {
    const script = isolationScript(plan);
    const aside = script.indexOf(`mount --bind ${shellQuote(WORKSPACE_ROOT)} ${shellQuote(MAIN_MOUNT)}`);
    const shadow = script.indexOf(`mount --bind ${shellQuote(`${HISTORY_ROOT}/worktrees/abc`)} ${shellQuote(WORKSPACE_ROOT)}`);
    expect(aside).toBeGreaterThan(-1);
    expect(shadow).toBeGreaterThan(aside);
});

test("shared state is re-bound from the aside mount, not from the shadowed path", () => {
    const script = isolationScript(plan);
    // From /work this would silently mount the worktree's empty copy; a bind, not overlay, reaches the daemon.
    const shared = SHARED_STATE_PATHS.map((path) => path.replace(/\/$/, ""));
    expect(shared).toContain(".intentic/records");
    expect(shared).toContain(".intentic/config/docs");
    for (const rel of shared) {
        expect(script).toContain(`mount --bind ${shellQuote(`${MAIN_MOUNT}/${rel}`)} ${shellQuote(`/work/${rel}`)}`);
        // Both sides may not exist yet; `set -e` needs them created first, not just mounted.
        expect(script).toContain(`mkdir -p ${shellQuote(`${MAIN_MOUNT}/${rel}`)} ${shellQuote(`/work/${rel}`)}`);
    }
    // The tracked slice is the worktree's own; binding over it would put the owner's config outside `land`.
    const targets = script
        .split("\n")
        .filter((line) => line.startsWith("mount --bind "))
        .map((line) => line.split(" ").at(-1));
    expect(targets).not.toContain(shellQuote("/work/.intentic"));
    expect(targets).not.toContain(shellQuote("/work/.intentic/config"));
});

test("the reference shelf comes back into the worktree, read-only, and only when the workspace has one", () => {
    const script = isolationScript(plan);
    // Without this, a turn comparing against a ref finds no /work/refs at all.
    expect(script).toContain(`if [ -d ${shellQuote(`${MAIN_MOUNT}/refs`)} ]; then`);
    expect(script).toContain(`mount --bind ${shellQuote(`${MAIN_MOUNT}/refs`)} ${shellQuote("/work/refs")}`);
    // `ro` is ignored on the bind itself; it only takes on the remount.
    expect(script).toContain(`mount -o remount,bind,ro ${shellQuote("/work/refs")}`);
    // Guarded: most workspaces have no shelf, and `set -e` would kill the namespace over its absence.
    expect(script).toContain(`fi`);
});

test("a mirrored tree is an overlay over the main checkout, never a writable bind onto it", () => {
    const script = isolationScript(plan);
    // pnpm hardlinks sources into node_modules; a writable bind would let a write rewrite the main checkout.
    expect(script).toContain(
        `mount -t overlay intentic-modules -o ${shellQuote(`lowerdir=${MAIN_MOUNT}/node_modules,upperdir=/history/overlays/abc/node_modules/upper,workdir=/history/overlays/abc/node_modules/work`)} ${shellQuote("/work/node_modules")}`,
    );
    // One overlay layer per package path; a nested tree must not share or nest inside the root's layer.
    expect(script).toContain(
        `mount -t overlay intentic-modules -o ${shellQuote(`lowerdir=${MAIN_MOUNT}/_apps/web/node_modules,upperdir=/history/overlays/abc/_apps%2Fweb%2Fnode_modules/upper,workdir=/history/overlays/abc/_apps%2Fweb%2Fnode_modules/work`)} ${shellQuote("/work/_apps/web/node_modules")}`,
    );
    // Both layer dirs must exist before the mount that names them.
    expect(script).toContain(
        `mkdir -p ${shellQuote("/work/node_modules")} ${shellQuote("/history/overlays/abc/node_modules/upper")} ${shellQuote("/history/overlays/abc/node_modules/work")}`,
    );
    // No leftover bind: a single one would reopen the whole hole.
    expect(script).not.toContain(`mount --bind ${shellQuote(`${MAIN_MOUNT}/node_modules`)}`);
    // Build output uses the same mechanism, or cross-package imports fail to resolve at collection.
    expect(script).toContain(
        `mount -t overlay intentic-modules -o ${shellQuote(`lowerdir=${MAIN_MOUNT}/_apps/web/dist,upperdir=/history/overlays/abc/_apps%2Fweb%2Fdist/upper,workdir=/history/overlays/abc/_apps%2Fweb%2Fdist/work`)} ${shellQuote("/work/_apps/web/dist")}`,
    );
});

test("a path that would corrupt the overlay option string is refused rather than mounted wrong", () => {
    // The kernel splits overlay options on `,`/`:`; either character in a path would mount the wrong thing silently.
    expect(() => isolationScript({ ...plan, overlays: "/history/overlays/a,b" })).toThrow(/cannot contain/);
});

test("the anchor announces readiness only after the mounts, then becomes the namespace's inhabitant", () => {
    const lines = isolationScript(plan).split("\n");
    // Readiness comes after the last mount, so a caller starting on it never finds a half-built namespace.
    expect(lines.at(-2)).toBe(`echo ${ANCHOR_READY}`);
    expect(lines.at(-1)).toBe("exec sleep infinity");
    expect(lines.findLastIndex((line) => line.startsWith("mount -t overlay"))).toBeLessThan(lines.length - 2);
    // `exec`, so the sleep is the pid nsenter targets, not a shell waiting on it under a different one.
    expect(lines.at(-1)?.startsWith("exec ")).toBe(true);
});

// `--wd` resolves before setns and lands on the daemon's own /work, unreachable inside the namespace (this killed Codex
// at startup); `--wdns` resolves after, so /work means the worktree.
test("entrants join the anchor's namespace by pid and start at the workspace root AS THE NAMESPACE SEES IT", () => {
    const { command, args } = nsenterArgv(4321, WORKSPACE_ROOT, "/usr/bin/claude", ["--flag", "value"]);
    expect(command).toBe("nsenter");
    expect(args).toEqual(["--mount=/proc/4321/ns/mnt", "--wdns=/work", "--", "env", "-u", "PWD", "-u", "OLDPWD", "/usr/bin/claude", "--flag", "value"]);
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
// in the namespace. Needs CAP_SYS_ADMIN; skipped otherwise, guarded there by mirror-roots.mjs.
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
const listing = (output: string, label: string): string[] =>
    (output.split("\n").find((line) => line.startsWith(`${label}:`)) ?? "")
        .slice(label.length + 1)
        .split(" ")
        .filter(Boolean)
        .toSorted();

test.skipIf(OVERLAY_SCRATCH === undefined)("emptying a mirror root keeps the turn's view of it; replacing it empties the turn's view", () => {
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
