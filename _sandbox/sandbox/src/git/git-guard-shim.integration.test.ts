import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// The `git` a shell here meets (bin/guard-shims/git): a move of the shared checkout off its main line is refused before
// git writes anything, as is a move of a conversation's own checkout (a linked worktree) onto that line, by any name git
// resolves to it, and a `worktree prune`, `repair`, `move` or `remove` where the sandbox keeps the git dir. Any other
// branch of a linked worktree, a repository outside the workspace, a file restore and every other command go straight
// to the real git. Driven as a shell drives it, on real repositories.

const SHIM_DIR = resolve(import.meta.dir, "../../bin/guard-shims");

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const repoAt = (dir: string, ...init: string[]): void => {
    git(dir, "init", "-q", "-b", "main", ...init);
    git(dir, "config", "user.email", "t@example.com");
    git(dir, "config", "user.name", "t");
    writeFileSync(join(dir, "a.txt"), "a\n");
    git(dir, "add", "a.txt");
    git(dir, "commit", "-qm", "a");
    git(dir, "branch", "feature");
};

const sandbox = () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "guard-shim-")));
    const root = join(base, "work");
    execFileSync("mkdir", ["-p", root]);
    repoAt(root);
    git(root, "config", "intentic.mainBranch", "main");
    const outside = join(base, "elsewhere");
    execFileSync("mkdir", ["-p", outside]);
    repoAt(outside);
    git(root, "worktree", "add", "-q", join(base, "copy"), "-b", "agent/c1");
    return { root, outside, copy: join(base, "copy") };
};

const shimWith = (env: Record<string, string>, cwd: string, ...args: string[]) => {
    const run = spawnSync("sh", [join(SHIM_DIR, "git"), ...args], {
        cwd,
        encoding: "utf8",
        env: { ...process.env, PATH: `${SHIM_DIR}:${process.env["PATH"] ?? ""}`, ...env },
    });
    return { status: run.status, stdout: run.stdout.trim(), stderr: run.stderr };
};

const shim = (root: string, cwd: string, ...args: string[]) => shimWith({ INTENTIC_WORKSPACE_ROOT: root }, cwd, ...args);

const headOf = (dir: string): string => git(dir, "symbolic-ref", "--short", "HEAD");

test("every spelling of a move off the main line is refused in the shared checkout, and nothing moves", () => {
    const { root } = sandbox();
    for (const args of [
        ["checkout", "feature"],
        ["checkout", "-q", "feature"],
        ["checkout", "-b", "topic"],
        ["checkout", "--detach"],
        ["checkout", "-"],
        // A bare trailing separator names no path: git still switches.
        ["checkout", "feature", "--"],
        // Options as git's own parser takes them: clustered, abbreviated, given with `=`, or taking the next word.
        ["checkout", "-qb", "topic"],
        ["checkout", "-btopic"],
        ["checkout", "-d"],
        ["checkout", "--orphan=topic"],
        ["checkout", "--det"],
        ["checkout", "--conflict", "merge", "feature"],
        ["switch", "feature"],
        ["switch", "-c", "topic"],
        ["switch", "--detach", "main"],
        ["switch", "--det"],
        ["-C", root, "checkout", "feature"],
        ["-c", "advice.detachedHead=false", "checkout", "HEAD~0"],
        ["symbolic-ref", "HEAD", "refs/heads/feature"],
    ]) {
        const run = shim(root, root, ...args);
        expect(run.status, args.join(" ")).toBe(1);
        expect(run.stderr, args.join(" ")).toContain("stays on `main`");
        expect(headOf(root)).toBe("main");
    }
    expect(git(root, "branch", "--list", "topic")).toBe("");
});

test("the main line itself, a file restore and every other verb go through", () => {
    const { root } = sandbox();
    writeFileSync(join(root, "a.txt"), "changed\n");
    expect(shim(root, root, "checkout", "--", "a.txt").status).toBe(0);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("a\n");
    writeFileSync(join(root, "a.txt"), "changed\n");
    expect(shim(root, root, "checkout", "a.txt").status).toBe(0);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("a\n");
    expect(shim(root, root, "checkout", "feature", "--", "a.txt").status).toBe(0);
    writeFileSync(join(root, "a.txt"), "changed\n");
    expect(shim(root, root, "checkout", "-qf", "--", "a.txt").status).toBe(0);
    expect(readFileSync(join(root, "a.txt"), "utf8")).toBe("a\n");
    expect(shim(root, root, "switch", "main").status).toBe(0);
    expect(shim(root, root, "checkout", "main").status).toBe(0);
    expect(shim(root, root, "checkout", "-qf", "main").status).toBe(0);
    expect(shim(root, root, "symbolic-ref", "--short", "HEAD").stdout).toBe("main");
    expect(shim(root, root, "branch", "topic").status).toBe(0);
    // The real git's own answer and exit code, untouched.
    expect(shim(root, root, "rev-parse", "--verify", "-q", "nothing-here").status).toBe(1);
    expect(headOf(root)).toBe("main");
});

test("a linked worktree and a repository outside the workspace are theirs to move", () => {
    const { root, outside, copy } = sandbox();
    expect(shim(root, copy, "switch", "-c", "elsewhere").status).toBe(0);
    expect(headOf(copy)).toBe("elsewhere");
    expect(shim(root, outside, "checkout", "feature").status).toBe(0);
    expect(headOf(outside)).toBe("feature");
});

test("a conversation's own checkout takes any branch but the main line, which stays the shared checkout's", () => {
    const { root, outside, copy } = sandbox();
    // `main` freed with git's own checkout, so what refuses below is the wrapper and not git's one-worktree-a-branch rule.
    git(root, "checkout", "-q", "feature");
    for (const args of [
        ["checkout", "main"],
        ["checkout", "refs/heads/main"],
        ["checkout", "main", "--"],
        ["switch", "main"],
        ["checkout", "-B", "main"],
        ["switch", "--create=main"],
        ["switch", "--ignore-other-worktrees", "main"],
        ["checkout", "--ignore-other-worktrees", "main"],
        ["symbolic-ref", "HEAD", "refs/heads/main"],
    ]) {
        const run = shim(root, copy, ...args);
        expect(run.status, args.join(" ")).toBe(1);
        expect(run.stderr, args.join(" ")).toContain("`main` is the shared workspace's line");
        expect(run.stderr, args.join(" ")).toContain("Back to main");
        expect(headOf(copy)).toBe("agent/c1");
    }
    // The privacy sandbox shows a conversation its own checkout as /work: under the workspace root, and still its own.
    expect(shim(join(root, ".."), copy, "checkout", "main").status).toBe(1);
    expect(headOf(copy)).toBe("agent/c1");
    git(root, "checkout", "-q", "main");

    expect(shim(root, copy, "checkout", "feature").status).toBe(0);
    expect(headOf(copy)).toBe("feature");
    // A start point on the main line leaves HEAD on the new branch.
    expect(shim(root, copy, "switch", "-c", "ci/fix", "main").status).toBe(0);
    expect(headOf(copy)).toBe("ci/fix");
    writeFileSync(join(copy, "a.txt"), "changed\n");
    expect(shim(root, copy, "checkout", "--", "a.txt").status).toBe(0);
    expect(readFileSync(join(copy, "a.txt"), "utf8")).toBe("a\n");
    writeFileSync(join(copy, "a.txt"), "changed\n");
    expect(shim(root, copy, "checkout", "main", "--", "a.txt").status).toBe(0);
    expect(readFileSync(join(copy, "a.txt"), "utf8")).toBe("a\n");
    expect(headOf(copy)).toBe("ci/fix");

    // A linked worktree of a repository the sandbox does not manage is git's own.
    git(outside, "worktree", "add", "-q", `${outside}-copy`, "-b", "agent/c1");
    git(outside, "checkout", "-q", "feature");
    expect(shim(root, `${outside}-copy`, "checkout", "main").status).toBe(0);
    expect(headOf(`${outside}-copy`)).toBe("main");
});

test("a conversation's own checkout reaches the main line by no name git resolves to it, nor by any option spelling", () => {
    const { root, copy } = sandbox();
    // The shared checkout off its main line, so git's own one-worktree-a-branch rule does not fire. The copy was on main
    // before its own branch, which makes main its `-` and `@{-1}`, and main is its branch's upstream.
    git(root, "checkout", "-q", "feature");
    git(copy, "checkout", "-q", "main");
    git(copy, "checkout", "-q", "agent/c1");
    git(copy, "branch", "-q", "--set-upstream-to=main");
    const refused = (...args: string[]) => {
        const run = shim(root, copy, ...args);
        expect(run.status, args.join(" ")).toBe(1);
        expect(run.stderr, args.join(" ")).toContain("`main` is the shared workspace's line");
        expect(run.stderr, args.join(" ")).toContain("Back to main");
    };
    for (const args of [
        ["checkout", "-"],
        ["checkout", "-q", "-"],
        ["checkout", "-", "--"],
        ["switch", "-"],
        ["checkout", "@{-1}"],
        ["switch", "@{-1}"],
        ["checkout", "@{u}"],
        ["switch", "agent/c1@{upstream}"],
        ["checkout", "-qB", "main"],
        ["checkout", "-qb", "main"],
        ["checkout", "-qBmain"],
        ["switch", "-qC", "main"],
        ["switch", "--force-cr=main"],
        ["switch", "--creat", "main"],
        ["checkout", "--orph=main"],
        ["checkout", "--ignore-oth", "feature"],
        ["checkout", "--conflict", "merge", "main"],
    ]) {
        refused(...args);
        expect(headOf(copy)).toBe("agent/c1");
    }
    git(copy, "branch", "-q", "--unset-upstream");

    // A restore from the branch before moves nothing.
    writeFileSync(join(copy, "a.txt"), "changed\n");
    expect(shim(root, copy, "checkout", "-", "--", "a.txt").status).toBe(0);
    expect(readFileSync(join(copy, "a.txt"), "utf8")).toBe("a\n");
    expect(headOf(copy)).toBe("agent/c1");

    // Two branches back is main all the same; one back is the copy's own branch, which `-` and `@{-1}` reach.
    git(copy, "checkout", "-q", "-b", "agent/c2");
    refused("checkout", "@{-2}");
    refused("switch", "@{-2}");
    expect(headOf(copy)).toBe("agent/c2");
    expect(shim(root, copy, "checkout", "-").status).toBe(0);
    expect(headOf(copy)).toBe("agent/c1");
    expect(shim(root, copy, "switch", "-").status).toBe(0);
    expect(headOf(copy)).toBe("agent/c2");
    expect(shim(root, copy, "checkout", "-q", "@{-1}").status).toBe(0);
    expect(headOf(copy)).toBe("agent/c1");
});

test("worktree prune, repair, move and remove are refused where the sandbox keeps the git dir, and are git's own elsewhere", () => {
    const base = realpathSync(mkdtempSync(join(tmpdir(), "guard-shim-")));
    const gits = join(base, "gits");
    const work = join(base, "work");
    const outside = join(base, "elsewhere");
    for (const dir of [gits, work, outside]) {
        mkdirSync(dir, { recursive: true });
    }
    repoAt(work, "--separate-git-dir", join(gits, "root"));
    repoAt(outside);
    git(work, "worktree", "add", "-q", join(base, "copy"), "-b", "agent/c1");
    // Another conversation's checkout, as the privacy sandbox shows it: its link registered, its directory not there.
    for (const dir of [work, outside]) {
        git(dir, "worktree", "add", "-q", `${dir}-hidden`, "-b", "agent/c2");
        rmSync(`${dir}-hidden`, { recursive: true, force: true });
    }
    const env = { INTENTIC_WORKSPACE_ROOT: work, INTENTIC_GITS_ROOT: gits };
    for (const [cwd, args] of [
        [work, ["worktree", "prune"]],
        [work, ["worktree", "repair"]],
        [work, ["worktree", "prune", "-v"]],
        [join(base, "copy"), ["worktree", "prune"]],
        [join(base, "copy"), ["worktree", "repair"]],
        [outside, ["-C", work, "worktree", "prune"]],
        // Inside the kept git dir itself, where git has no work tree.
        [join(gits, "root"), ["worktree", "prune"]],
        [work, ["worktree", "remove", `${work}-hidden`]],
        [work, ["worktree", "remove", "--force", join(base, "copy")]],
        [join(base, "copy"), ["worktree", "move", join(base, "copy"), join(base, "moved")]],
        [work, ["worktree", "move", `${work}-hidden`, join(base, "moved")]],
    ] as const) {
        const run = shimWith(env, cwd, ...args);
        expect(run.status, `${cwd}: ${args.join(" ")}`).toBe(1);
        expect(run.stderr, `${cwd}: ${args.join(" ")}`).toContain("keeps this repository's worktree links itself");
    }
    expect(shimWith(env, work, "worktree", "remove", `${work}-hidden`).stderr).toContain("would break the conversation");
    const list = shimWith(env, work, "worktree", "list");
    expect(list.status).toBe(0);
    expect(list.stdout).toContain(`${work}-hidden`);
    expect(list.stdout).toContain(join(base, "copy"));
    expect(list.stdout).not.toContain(join(base, "moved"));
    // add, lock and unlock go through.
    expect(shimWith(env, work, "worktree", "add", "-q", join(base, "extra"), "-b", "agent/c3").status).toBe(0);
    expect(shimWith(env, work, "worktree", "lock", join(base, "extra")).status).toBe(0);
    expect(shimWith(env, work, "worktree", "unlock", join(base, "extra")).status).toBe(0);

    expect(shimWith(env, outside, "worktree", "prune").status).toBe(0);
    expect(git(outside, "worktree", "list")).not.toContain(`${outside}-hidden`);
    expect(shimWith(env, outside, "worktree", "repair").status).toBe(0);
    git(outside, "worktree", "add", "-q", `${outside}-extra`, "-b", "agent/c3");
    expect(shimWith(env, outside, "worktree", "move", `${outside}-extra`, `${outside}-moved`).status).toBe(0);
    expect(shimWith(env, outside, "worktree", "remove", `${outside}-moved`).status).toBe(0);
    expect(git(outside, "worktree", "list")).not.toContain(`${outside}-`);
});
