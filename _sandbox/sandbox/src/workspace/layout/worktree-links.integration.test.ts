import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { commitWorktreeRemainder } from "../../git/remote/root-repo.js";
import { createLogger } from "../../logger.js";
import { repoGitDir } from "./git-layout.js";
import { healSharedCheckoutLinks, linkLayoutOf, linkOne, SharedCheckoutLinkError } from "./worktree-links.js";

// The targowisko hijack (2026-11-11), replayed with real git: a worktree record naming the shared checkout, as git
// inside the privacy jail writes it, turns the next `worktree repair` of ANY other checkout into a rewrite of the shared
// checkout's `.git`. The heal puts both back without touching a file.

const logger = createLogger({ logLevel: "silent", logPretty: false, historyRoot: "" });
const git = (dir: string, ...args: string[]): string => execFileSync("git", ["-C", dir, ...args], { encoding: "utf8" }).trim();

const bases: string[] = [];
afterEach(() => {
    for (const base of bases.splice(0)) {
        rmSync(base, { recursive: true, force: true });
    }
});

const workspace = () => {
    const base = mkdtempSync(join(tmpdir(), "worktree-links-"));
    bases.push(base);
    const workspaceRoot = join(base, "work");
    const historyRoot = join(base, "history");
    const layout = linkLayoutOf(workspaceRoot, join(historyRoot, "worktrees"));
    const shared = layout.mainDir("app");
    mkdirSync(shared, { recursive: true });
    mkdirSync(join(historyRoot, "gits"), { recursive: true });
    git(shared, "init", "-q", "-b", "main", "--separate-git-dir", repoGitDir(historyRoot, "app"));
    git(shared, "config", "user.email", "t@example.com");
    git(shared, "config", "user.name", "t");
    writeFileSync(join(shared, "readme.md"), "v1\n");
    git(shared, "add", "-A");
    git(shared, "commit", "-qm", "init");
    const conversation = (id: string): string => {
        const dir = layout.worktreeDir(id, "app");
        mkdirSync(join(dir, ".."), { recursive: true });
        git(shared, "worktree", "add", "-q", "-b", `agent/${id}`, dir);
        return dir;
    };
    const adminOf = (checkout: string): string => readFileSync(join(checkout, ".git"), "utf8").replace(/^gitdir:\s*/u, "").trim();
    return { layout, shared, common: repoGitDir(historyRoot, "app"), conversation, adminOf };
};

test("a worktree record naming the shared checkout hijacks it on the next repair, and the heal undoes both", async () => {
    const { layout, shared, common, conversation, adminOf } = workspace();
    const home = conversation("home");
    const other = conversation("other");
    writeFileSync(join(shared, "edit.txt"), "the person's uncommitted edit\n");
    const homeAdmin = adminOf(home);

    // What git inside the jail leaves behind: the home conversation's record names `/work/app/.git`.
    writeFileSync(join(homeAdmin, "gitdir"), `${join(shared, ".git")}\n`);
    // An ordinary relink of another conversation, as the daemon used to run it.
    git(shared, "worktree", "repair", other);
    expect(git(shared, "rev-parse", "--abbrev-ref", "HEAD")).toBe("agent/home");

    const healed = await healSharedCheckoutLinks(layout, ["app"], logger);

    expect(healed.map(({ kind }) => kind)).toEqual(["worktree-record", "shared-checkout"]);
    expect(readFileSync(join(shared, ".git"), "utf8")).toBe(`gitdir: ${common}\n`);
    expect(git(shared, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(readFileSync(join(homeAdmin, "gitdir"), "utf8").trim()).toBe(join(home, ".git"));
    expect(git(home, "rev-parse", "--abbrev-ref", "HEAD")).toBe("agent/home");
    expect(readFileSync(join(shared, "edit.txt"), "utf8")).toBe("the person's uncommitted edit\n");
    // A second repair now leaves the shared checkout where it is.
    git(shared, "worktree", "repair", other);
    expect(git(shared, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
    expect(await healSharedCheckoutLinks(layout, ["app"], logger)).toEqual([]);
});

test("a record whose checkout stands on another branch is found by the checkout that leads into it", async () => {
    const { layout, shared, conversation, adminOf } = workspace();
    const ci = conversation("ci");
    git(ci, "switch", "-q", "-c", "fix/ci");
    const admin = adminOf(ci);
    writeFileSync(join(admin, "gitdir"), `${join(shared, ".git")}\n`);

    await healSharedCheckoutLinks(layout, ["app"], logger);

    expect(readFileSync(join(admin, "gitdir"), "utf8").trim()).toBe(join(ci, ".git"));
});

test("a record nothing leads into any more is written somewhere git reads as prunable, never as the shared checkout", async () => {
    const { layout, shared, conversation, adminOf } = workspace();
    const gone = conversation("gone");
    const admin = adminOf(gone);
    writeFileSync(join(admin, "gitdir"), `${join(shared, ".git")}\n`);
    rmSync(gone, { recursive: true, force: true });

    await healSharedCheckoutLinks(layout, ["app"], logger);

    expect(git(shared, "worktree", "list", "--porcelain")).toContain(`worktree ${join(admin, "orphaned-checkout")}\nHEAD`);
    expect(git(shared, "worktree", "list", "--porcelain")).toContain("prunable");
    expect(git(shared, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
});

test("linkOne writes the one pair it names and refuses a shared checkout", async () => {
    const { layout, shared, conversation, adminOf } = workspace();
    const own = conversation("own");
    const admin = adminOf(own);
    writeFileSync(join(admin, "gitdir"), "/nowhere/.git\n");

    await linkOne(admin, own, [shared]);
    expect(readFileSync(join(admin, "gitdir"), "utf8").trim()).toBe(join(own, ".git"));
    expect(git(own, "rev-parse", "--abbrev-ref", "HEAD")).toBe("agent/own");

    await expect(linkOne(admin, shared, [layout.mainDir("root"), shared])).rejects.toBeInstanceOf(SharedCheckoutLinkError);
    expect(git(shared, "rev-parse", "--abbrev-ref", "HEAD")).toBe("main");
});

// /history reached through a link: git writes resolved paths into the pointers it makes, the daemon the configured
// spelling. A record naming the shared checkout must still find its live owner, never be written off as orphaned.
test("an owner whose pointer spells the history root differently is still found", async () => {
    const base = mkdtempSync(join(tmpdir(), "worktree-links-symlink-"));
    bases.push(base);
    const real = join(base, "history-real");
    mkdirSync(join(real, "gits"), { recursive: true });
    symlinkSync(real, join(base, "history"));
    const historyRoot = join(base, "history");
    const layout = linkLayoutOf(join(base, "work"), join(historyRoot, "worktrees"));
    const shared = layout.mainDir("app");
    mkdirSync(shared, { recursive: true });
    git(shared, "init", "-q", "-b", "main", "--separate-git-dir", repoGitDir(historyRoot, "app"));
    writeFileSync(join(shared, ".git"), `gitdir: ${repoGitDir(historyRoot, "app")}\n`);
    git(shared, "-c", "user.email=t@t", "-c", "user.name=t", "commit", "-q", "--allow-empty", "-m", "init");
    const home = layout.worktreeDir("home", "app");
    mkdirSync(join(home, ".."), { recursive: true });
    git(shared, "worktree", "add", "-q", "-b", "agent/home", home);
    const admin = readFileSync(join(home, ".git"), "utf8").replace(/^gitdir:\s*/u, "").trim();
    writeFileSync(join(admin, "gitdir"), `${join(shared, ".git")}\n`);

    await healSharedCheckoutLinks(layout, ["app"], logger);

    expect(readFileSync(join(admin, "gitdir"), "utf8").trim()).toBe(join(home, ".git"));
    expect(git(home, "rev-parse", "--abbrev-ref", "HEAD")).toBe("agent/home");
});

// Every commit of a conversation's checkout goes through commitWorktreeRemainder (checkpoint, land, sync, retire). One
// standing on the main line, or on a branch another checkout holds, is detached first; its own branch and the shared
// checkout itself commit as ever.
test("a commit of a checkout standing on a line someone else stands on never moves that line", async () => {
    const { shared, conversation } = workspace();
    const workspaceRoot = join(shared, "..");
    const mainBefore = git(shared, "rev-parse", "main");
    const onMain = conversation("main-taker");
    git(onMain, "switch", "-q", "--ignore-other-worktrees", "main");
    writeFileSync(join(onMain, "edit.txt"), "edit\n");
    expect(await commitWorktreeRemainder("app", onMain, "on main", workspaceRoot)).toBe(true);
    expect(git(shared, "rev-parse", "main")).toBe(mainBefore);
    expect(() => git(onMain, "symbolic-ref", "-q", "HEAD")).toThrow();

    // A branch's view holds `release`; a conversation that switched onto it does not commit onto that line either.
    git(shared, "branch", "release");
    git(conversation("view"), "switch", "-q", "release");
    const viewTip = git(shared, "rev-parse", "release");
    const onRelease = conversation("release-taker");
    git(onRelease, "switch", "-q", "--ignore-other-worktrees", "release");
    writeFileSync(join(onRelease, "edit.txt"), "edit\n");
    await commitWorktreeRemainder("app", onRelease, "on release", workspaceRoot);
    expect(git(shared, "rev-parse", "release")).toBe(viewTip);

    const own = conversation("own");
    writeFileSync(join(own, "edit.txt"), "edit\n");
    await commitWorktreeRemainder("app", own, "own", workspaceRoot);
    expect(git(own, "symbolic-ref", "--short", "HEAD")).toBe("agent/own");
    expect(git(shared, "rev-parse", "agent/own")).not.toBe(mainBefore);

    writeFileSync(join(shared, "edit.txt"), "edit\n");
    await commitWorktreeRemainder("app", shared, "shared", workspaceRoot);
    expect(git(shared, "rev-parse", "main")).not.toBe(mainBefore);
});
