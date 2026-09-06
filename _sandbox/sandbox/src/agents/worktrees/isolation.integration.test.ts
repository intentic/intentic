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

/* The namespace itself needs CAP_SYS_ADMIN, which no test runner is guaranteed to have, so what is asserted
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
    worktree: `${HISTORY_ROOT}/worktrees/abc`,
    root: WORKSPACE_ROOT,
    mirrors: ["node_modules", "_apps/web/node_modules", "_apps/web/dist"],
    overlays: `${HISTORY_ROOT}/overlays/abc`,
};

test("the namespace is made private before anything is mounted", () => {
    const lines = isolationScript(plan).split("\n");
    expect(lines[0]).toBe("set -e");
    expect(lines[1]).toBe("mount --make-rprivate /");
    // Every mount comes after it: otherwise the "isolated" turn rewrites the daemon's own /work.
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
    // Sourcing these from /work would name the worktree's own (empty) copy: the mount would succeed and the
    // agent would silently lose the transcript store. A BIND, not an overlay: a transcript written here has
    // to reach the daemon. Every untracked group, and the one untracked entry inside the tracked one.
    const shared = SHARED_STATE_PATHS.map((path) => path.replace(/\/$/, ""));
    expect(shared).toContain(".intentic/records");
    expect(shared).toContain(".intentic/config/docs");
    for (const rel of shared) {
        expect(script).toContain(`mount --bind ${shellQuote(`${MAIN_MOUNT}/${rel}`)} ${shellQuote(`/work/${rel}`)}`);
        // Mount points on BOTH sides: a fresh checkout has none for an untracked dir, and a sandbox that has
        // never staged a doc or stored a secret has no source dir yet either, which under `set -e` would be a
        // dead anchor rather than an empty mount.
        expect(script).toContain(`mkdir -p ${shellQuote(`${MAIN_MOUNT}/${rel}`)} ${shellQuote(`/work/${rel}`)}`);
    }
    // The tracked slice is the worktree's own checkout. Binding the whole dir over it, or the slice itself, is
    // exactly what put the owner's configuration outside `land` and forced every worktree to sparse-exclude it.
    const targets = script
        .split("\n")
        .filter((line) => line.startsWith("mount --bind "))
        .map((line) => line.split(" ").at(-1));
    expect(targets).not.toContain(shellQuote("/work/.intentic"));
    expect(targets).not.toContain(shellQuote("/work/.intentic/config"));
});

test("the reference shelf comes back into the worktree, read-only, and only when the workspace has one", () => {
    const script = isolationScript(plan);
    // Without this a turn asked to "compare against refs/nimbalyst" finds no /work/refs at all and spends a
    // call rediscovering that the shelf only exists at MAIN_MOUNT.
    expect(script).toContain(`if [ -d ${shellQuote(`${MAIN_MOUNT}/refs`)} ]; then`);
    expect(script).toContain(`mount --bind ${shellQuote(`${MAIN_MOUNT}/refs`)} ${shellQuote("/work/refs")}`);
    // `ro` is ignored on the bind itself: it takes only on the remount, and the shelf is read-only by contract.
    expect(script).toContain(`mount -o remount,bind,ro ${shellQuote("/work/refs")}`);
    // Guarded, because most workspaces have no shelf and `set -e` would kill the namespace over its absence.
    expect(script).toContain(`fi`);
});

test("a mirrored tree is an overlay over the main checkout, never a writable bind onto it", () => {
    const script = isolationScript(plan);
    // The whole point: pnpm hardlinks workspace sources into node_modules, so a WRITABLE bind here let a
    // write through the node_modules name rewrite the main checkout's tracked file. Reads still come from
    // the main tree (lowerdir); writes land in this turn's own upper layer.
    expect(script).toContain(
        `mount -t overlay intentic-modules -o ${shellQuote(`lowerdir=${MAIN_MOUNT}/node_modules,upperdir=/history/overlays/abc/node_modules/upper,workdir=/history/overlays/abc/node_modules/work`)} ${shellQuote("/work/node_modules")}`,
    );
    // One layer per mount, keyed by the package path: a nested tree must not share (or nest inside) the
    // root's layer, and upper/work must be siblings.
    expect(script).toContain(
        `mount -t overlay intentic-modules -o ${shellQuote(`lowerdir=${MAIN_MOUNT}/_apps/web/node_modules,upperdir=/history/overlays/abc/_apps%2Fweb%2Fnode_modules/upper,workdir=/history/overlays/abc/_apps%2Fweb%2Fnode_modules/work`)} ${shellQuote("/work/_apps/web/node_modules")}`,
    );
    // Both layer dirs have to exist before the mount that names them.
    expect(script).toContain(
        `mkdir -p ${shellQuote("/work/node_modules")} ${shellQuote("/history/overlays/abc/node_modules/upper")} ${shellQuote("/history/overlays/abc/node_modules/work")}`,
    );
    // Nothing binds a dependency tree any more: a single leftover bind is the whole hole reopened.
    expect(script).not.toContain(`mount --bind ${shellQuote(`${MAIN_MOUNT}/node_modules`)}`);
    // Build output rides the same mechanism: without it a worktree resolves third-party imports but not its
    // own siblings', and every suite that crosses a package boundary dies at collection.
    expect(script).toContain(
        `mount -t overlay intentic-modules -o ${shellQuote(`lowerdir=${MAIN_MOUNT}/_apps/web/dist,upperdir=/history/overlays/abc/_apps%2Fweb%2Fdist/upper,workdir=/history/overlays/abc/_apps%2Fweb%2Fdist/work`)} ${shellQuote("/work/_apps/web/dist")}`,
    );
});

test("a path that would corrupt the overlay option string is refused rather than mounted wrong", () => {
    // The kernel splits these options on "," and ":", so a path carrying either would mount something other
    // than what was asked for, which is exactly the silent-wrong-tree failure this module exists to prevent.
    expect(() => isolationScript({ ...plan, overlays: "/history/overlays/a,b" })).toThrow(/cannot contain/);
});

test("the anchor announces readiness only after the mounts, then becomes the namespace's inhabitant", () => {
    const lines = isolationScript(plan).split("\n");
    // Readiness AFTER the last mount: a caller that starts work on the announcement must never find a
    // half-built namespace writing through to the shared tree.
    expect(lines.at(-2)).toBe(`echo ${ANCHOR_READY}`);
    expect(lines.at(-1)).toBe("exec sleep infinity");
    expect(lines.findLastIndex((line) => line.startsWith("mount -t overlay"))).toBeLessThan(lines.length - 2);
    // `exec`, so the sleep IS the pid nsenter targets: a shell waiting on a child would hold the namespace
    // under a different pid than the one handed out.
    expect(lines.at(-1)?.startsWith("exec ")).toBe(true);
});

/* The flag is the assertion. `--wd` resolves before setns and lands the entrant on the daemon's own /work,
 * the shared checkout, whose mount has no path at all inside the namespace: relative writes leak there
 * silently, and getcwd answers `(unreachable)/work`, which is what killed the Codex app-server at startup.
 * `--wdns` resolves after setns, so "/work" means the worktree. Pinning the spelling is what keeps the
 * enforcement layer from being undone by a one-word change. */
test("entrants join the anchor's namespace by pid and start at the workspace root AS THE NAMESPACE SEES IT", () => {
    const { command, args } = nsenterArgv(4321, WORKSPACE_ROOT, "/usr/bin/claude", ["--flag", "value"]);
    expect(command).toBe("nsenter");
    expect(args).toEqual(["--mount=/proc/4321/ns/mnt", "--wdns=/work", "--", "env", "-u", "PWD", "-u", "OLDPWD", "/usr/bin/claude", "--flag", "value"]);
    expect(args).not.toContain(`--wd=${WORKSPACE_ROOT}`);
});

/* THE OTHER HALF OF THE SAME GUARANTEE, and the one that cost two turns' checks to find: `--wdns` moves the
 * kernel's cwd, and `PWD` rides in from the daemon naming the worktree's own path. Bash keeps a stale `$PWD`
 * whenever it still names the current directory, which a bind mount of that worktree over /work guarantees, so
 * `cd intentic` resolved under `/history/worktrees/<id>` where no mirror is mounted and `pnpm verify` died on
 * `prisma: not found` in a fully installed workspace. Unset, every shell falls back to `getcwd()`. */
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
    // Outside the root: the same file in both namespaces.
    expect(inWorktree("/root/.claude/memory/x.md", plan)).toBe("/root/.claude/memory/x.md");
    // Not isolated at all.
    expect(inWorktree("/work/intentic/src/x.ts", undefined)).toBe("/work/intentic/src/x.ts");
});

/* The same mapping backwards, for quoting a daemon-side answer into the conversation: a type diagnostic above
 * all. The worktree path is real and openable, and reaching it directly is what puts a turn's edits outside its
 * own namespace, so a report that names it reads as an instruction to go there. */
test("a path the daemon reports is translated back to the name the agent uses", () => {
    expect(fromWorktree("/history/worktrees/abc/intentic/src/x.ts", plan)).toBe("/work/intentic/src/x.ts");
    expect(fromWorktree("/history/worktrees/abc", plan)).toBe("/work");
    // Already in the agent's naming, outside the root, or not isolated: left exactly as it is.
    expect(fromWorktree("/work/intentic/src/x.ts", plan)).toBe("/work/intentic/src/x.ts");
    expect(fromWorktree("/root/.claude/memory/x.md", plan)).toBe("/root/.claude/memory/x.md");
    expect(fromWorktree("/history/worktrees/abc/intentic/src/x.ts", undefined)).toBe("/history/worktrees/abc/intentic/src/x.ts");
    // A sibling worktree whose path merely starts the same way is a different conversation's tree.
    expect(fromWorktree("/history/worktrees/abcd/intentic/src/x.ts", plan)).toBe("/history/worktrees/abcd/intentic/src/x.ts");
});

test("translating a worktree path out and back is the path it started as", () => {
    expect(fromWorktree(inWorktree("/work/intentic/src/x.ts", plan), plan)).toBe("/work/intentic/src/x.ts");
});

test("re-bound subtrees resolve to the main tree in both namespaces and are never translated", () => {
    // Translating these would send the daemon looking in a worktree that has no such file.
    expect(inWorktree("/work/.intentic/records/artifacts/attachments/a.png", plan)).toBe("/work/.intentic/records/artifacts/attachments/a.png");
    expect(inWorktree("/work/_apps/web/node_modules/vue/index.js", plan)).toBe("/work/_apps/web/node_modules/vue/index.js");
    // The staged docs tree is the untracked entry INSIDE the tracked group, and shared like the groups are.
    expect(inWorktree("/work/.intentic/config/docs/root/repo.json", plan)).toBe("/work/.intentic/config/docs/root/repo.json");
    // A path that merely STARTS like one of them is still worktree content.
    expect(inWorktree("/work/.intentic-notes/x.md", plan)).toBe("/history/worktrees/abc/.intentic-notes/x.md");
});

test("the tracked state slice is the worktree's own, so it moves with the root like any other file", () => {
    // A daemon-side reader handed `/work/.intentic/config/settings.json` by an isolated agent must open the
    // agent's copy; the redirect layer must write there. Left untranslated, the edit would reach the live
    // tree with no branch, no land and no author, which is the very bug this boundary exists to close.
    expect(inWorktree("/work/.intentic/config/settings.json", plan)).toBe("/history/worktrees/abc/.intentic/config/settings.json");
    expect(inWorktree("/work/.intentic/config/approvals/post-1.json", plan)).toBe("/history/worktrees/abc/.intentic/config/approvals/post-1.json");
    expect(inWorktree("/work/.intentic/config", plan)).toBe("/history/worktrees/abc/.intentic/config");
    expect(fromWorktree("/history/worktrees/abc/.intentic/config/settings.json", plan)).toBe("/work/.intentic/config/settings.json");
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
    // A build CACHE is deliberately not mirrored: main's tsbuildinfo would tell the turn's incremental build
    // that the mirrored dist already covers sources the turn has since changed.
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

    // The repo TRACKS its dist, so the checkout carries it. Mounting the main tree's over it would hide the
    // very files the agent's branch exists to change.
    const worktree = await checkout();
    await mkdir(join(worktree, "_libs", "ui", "dist"), { recursive: true });
    await writeFile(join(worktree, "_libs", "ui", "dist", "index.js"), "the agent's own\n");

    expect(await mirroredDirs(root, worktree, { intoNestedRepos: true })).toEqual(["_libs/ui/node_modules"]);
});

/* THE TWO HALVES OF THE MIRROR-ROOT INVARIANT, PINNED TO EACH OTHER. Every name in MIRRORED_DIRS becomes an
 * overlay whose lowerdir is the main checkout's directory, and an overlay resolves that lowerdir once: a
 * main-tree command that REPLACES one of these directories rather than emptying it leaves every live turn's
 * merged view of it reading empty (see @intentic/constants/mirror-roots, and the TS6307 on prisma's freshly
 * generated `client.ts` that it cost). `_tools/checks/mirror-roots.mjs` refuses that shape for every name in
 * the same set, so a name discovered here that the gate does not read would be a directory nothing protects.
 * Derived from the set rather than transcribed, which is what makes adding a fourth name mean adding coverage. */
test("every name the shared set carries is discovered as a mirror, and nothing else is", async () => {
    const root = await mkdtemp(join(tmpdir(), "isolation-"));
    tempDirs.push(root);
    for (const dir of MIRRORED_DIRS) {
        await mkdir(join(root, "_libs", "ui", dir), { recursive: true });
    }
    // A neighbour that is untracked build output too, and deliberately NOT mirrored: main's tsbuildinfo would
    // tell the turn's incremental build that the mirrored dist already covers sources the turn has changed.
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
    // The PLAN spans the workspace: each nested worktree is mounted under the same root, so it wants both.
    expect(await mirroredDirs(root, worktree, { intoNestedRepos: true })).toEqual(["node_modules", "intent/node_modules"]);
    // The symlink mirror runs per repo, and planting `intent/node_modules` from here would put the nested
    // repo's link inside the PARENT's checkout.
    expect(await mirroredDirs(root, worktree, { intoNestedRepos: false })).toEqual(["node_modules"]);
});

/* AGAINST A REAL OVERLAY, because the rule the rest of this repository is now shaped around is a claim about
 * the kernel and nothing else can settle it.
 *
 * An overlay resolves its lowerdir ONCE, at mount time. Every mirror above is mounted with the MAIN checkout's
 * directory as that lower, and the main tree keeps being built on while turns are open, so what the main tree
 * is allowed to do to those directories is the whole safety argument. The measured answer, below, is that
 * emptying one is free and REPLACING one is fatal: after `rm -rf dist && mkdir dist` on the lower, the merged
 * directory reads as completely empty — not even the file the turn itself wrote into the upper layer, which is
 * still `stat`-able by name — and no remount inside the namespace brings it back.
 *
 * That is what `_platform/prisma`'s `rm -rf ./generated` did to every open conversation at once: a `client.ts`
 * that `prisma generate` had just written, sitting in a directory `readdir` swore was empty, so the tsconfig's
 * `./generated/**` include matched nothing and the declarations emit failed TS6307 on the turn-ending check of
 * every agent, whatever it had changed. `_tools/scripts/build/clean-outputs.mjs` is the remedy and is driven here
 * rather than imitated: this test fails if that script ever starts replacing what it is supposed to empty.
 *
 * THE MODE: a real mount namespace with a real overlayfs, which needs CAP_SYS_ADMIN, and an upperdir on a
 * filesystem that is not itself an overlay — a container's own root usually is one, which is why this uses the
 * history volume exactly as isolationAvailable's probe does. Skipped where either is missing (CI, a dev host),
 * and the shape it protects is guarded there by _tools/checks/mirror-roots.mjs instead. */
/* The measurement as one shell program, because the mount only exists inside the namespace it is made in: put
 * the overlay up, then run whatever the caller wants to say about it. */
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
    // The mount IS the probe: seccomp can refuse the syscall with the capability present, and overlayfs is its
    // own kernel gate. Made and torn down in one namespace, so nothing is left holding the directory busy.
    const probe = spawnSync("unshare", ["--mount", "--propagation", "private", "sh", "-c", overlayShell(dir, "true")], { timeout: 10_000 });
    if (probe.status === 0) {
        return dir;
    }
    // Nothing else will ever hear about this directory, so it is reclaimed here rather than by the afterEach,
    // which only sees a scratch a running test took ownership of.
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
                    // The turn's own emit, landing in this conversation's upper layer.
                    `printf turn > ${shellQuote(`${merged}/turn.js`)}`,
                    // The main tree clears and rewrites its dist underneath, the sanctioned way, through the
                    // very script every build script in this repository now calls.
                    `node ${shellQuote(clean)} ${shellQuote(lower)} > /dev/null`,
                    `printf main > ${shellQuote(`${lower}/main.js`)}`,
                    `echo "emptied: $(ls ${shellQuote(merged)} | tr '\\n' ' ')"`,
                    // And the way that used to be written, which gives the path a new inode.
                    `rm -rf ${shellQuote(lower)} && mkdir ${shellQuote(lower)} && printf main > ${shellQuote(`${lower}/main.js`)}`,
                    `echo "replaced: $(ls ${shellQuote(merged)} | tr '\\n' ' ')"`,
                    // The upper layer is untouched by either: the file is there, only readdir stopped saying so.
                    `echo "stat: $(cat ${shellQuote(`${merged}/turn.js`)} 2>&1)"`,
                ].join("\n"),
            ),
        ],
        { encoding: "utf8", timeout: 30_000 },
    );
    expect(result.stderr).toBe("");
    // Emptied in place: the lower's new output and the turn's own file, both there, which is what makes
    // mirroring a directory the main tree keeps rebuilding workable at all.
    expect(listing(result.stdout, "emptied")).toEqual(["main.js", "turn.js"]);
    // Replaced: nothing at all, the turn's own upper-layer file included. This is the outage.
    expect(listing(result.stdout, "replaced")).toEqual([]);
    // And it is a readdir failure, not a data loss: the same file still opens by name, which is exactly why
    // TS6307 was the symptom rather than a missing file.
    expect(result.stdout).toContain("stat: turn");
});
