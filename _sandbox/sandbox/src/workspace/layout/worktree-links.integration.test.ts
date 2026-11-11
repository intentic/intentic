import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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
