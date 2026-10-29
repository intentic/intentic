import { execFileSync, spawnSync } from "node:child_process";
import { mkdtempSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

// The `git` a shell here meets (bin/guard-shims/git): a move of the shared checkout off its main line is refused before
// git writes anything, while a linked worktree, a repository outside the workspace, a file restore and every other
// command go straight to the real git. Driven as a shell drives it, on real repositories.

const SHIM_DIR = resolve(import.meta.dir, "../../bin/guard-shims");

const git = (cwd: string, ...args: string[]): string => execFileSync("git", args, { cwd, encoding: "utf8" }).trim();

const repoAt = (dir: string): void => {
    git(dir, "init", "-q", "-b", "main");
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

const shim = (root: string, cwd: string, ...args: string[]) => {
    const run = spawnSync("sh", [join(SHIM_DIR, "git"), ...args], {
        cwd,
        encoding: "utf8",
        env: { ...process.env, PATH: `${SHIM_DIR}:${process.env["PATH"] ?? ""}`, INTENTIC_WORKSPACE_ROOT: root },
    });
    return { status: run.status, stdout: run.stdout.trim(), stderr: run.stderr };
};

const headOf = (dir: string): string => git(dir, "symbolic-ref", "--short", "HEAD");

test("every spelling of a move off the main line is refused in the shared checkout, and nothing moves", () => {
    const { root } = sandbox();
    for (const args of [
        ["checkout", "feature"],
        ["checkout", "-q", "feature"],
        ["checkout", "-b", "topic"],
        ["checkout", "--detach"],
        ["checkout", "-"],
        ["switch", "feature"],
        ["switch", "-c", "topic"],
        ["switch", "--detach", "main"],
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
    expect(shim(root, root, "switch", "main").status).toBe(0);
    expect(shim(root, root, "checkout", "main").status).toBe(0);
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
