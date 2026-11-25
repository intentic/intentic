import { execFile } from "node:child_process";
import { existsSync, lstatSync } from "node:fs";
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { CHECKOUT_HOOKS_FILE } from "@intentic/sandbox-contract/schemas/checkout-hooks";
import { defaultGit, gitInit } from "@intentic/base/git";
import { noIsolation } from "../isolation.testing.js";
import { ensureRootRepo } from "../../../git/remote/root-repo.js";
import { repoGitDir } from "../../../workspace/layout/git-layout.js";
import { createLogger } from "../../../logger.js";
import { createPerfTracker } from "../../../system/resources/perf.js";
import { workspacePaths } from "../../../workspace/workspace.js";
import { createAgentWorktrees } from "../worktrees.js";
import { DEFAULT_SCAN_LIMITS, KEPT_MANIFEST, scanAtRiskLocalFiles } from "./local-files.js";
import { parseIncludeLine } from "./worktree-include.js";
import { ArchiveHookFailed, checkoutHookSet, takeCheckoutSetupNote } from "./checkout-hooks.js";
import { approveHookSet, hookRequests, revokeHookSet } from "../../../guard/hook-approvals.js";

// The checkout lifecycle end to end over a production-shaped workspace: what a retire keeps of the ignored files only
// the checkout held (local-files.ts), what `.worktreeinclude` copies in (worktree-include.ts), and the repository's
// setup and archive hooks behind the owner's approval (checkout-hooks.ts).

const exec = promisify(execFile);
const sh = async (cwd: string, ...args: string[]): Promise<string> => (await exec("git", ["-C", cwd, ...args])).stdout.trim();
const logger = createLogger({ logLevel: "silent", logPretty: false, historyRoot: "" });
const perf = createPerfTracker(logger);

const tempDirs: string[] = [];
afterEach(async () => {
    for (const dir of tempDirs.splice(0)) {
        await rm(dir, { recursive: true, force: true });
    }
});

const commit = async (dir: string, message: string): Promise<void> => {
    await sh(dir, "add", "-A");
    await sh(dir, "-c", "user.name=t", "-c", "user.email=t@t", "commit", "-q", "-m", message);
};

// /work with a root repo on /history and one nested repo, `app`, whose files the case writes before its first commit.
const setup = async (files: Readonly<Record<string, string>>) => {
    const base = await mkdtemp(join(tmpdir(), "intentic-checkout-lifecycle-"));
    tempDirs.push(base);
    const work = join(base, "work");
    const historyRoot = join(base, "history");
    const workspace = workspacePaths(work);
    const app = join(work, "app");
    await mkdir(app, { recursive: true });
    await gitInit(app, repoGitDir(historyRoot, "app"));
    for (const [path, text] of Object.entries(files)) {
        await mkdir(join(app, path, ".."), { recursive: true });
        await writeFile(join(app, path), text);
    }
    await commit(app, "app v1");
    await ensureRootRepo(workspace, historyRoot);
    await writeFile(join(work, "CLAUDE.md"), "notes\n");
    await commit(work, "baseline");
    const worktrees = createAgentWorktrees(
        { workspace, worktreesRoot: join(historyRoot, "worktrees"), historyRoot, isolation: noIsolation(work, historyRoot), logger, perf, relocateGitDirs: () => true },
    );
    return { work, app, historyRoot, worktrees };
};

const trashEntries = async (historyRoot: string): Promise<string[]> => (await readdir(join(historyRoot, "trash")).catch(() => [])).filter((name) => name.includes("local-files"));

test("a retire keeps the ignored files only the checkout held, in the trash, and passes over what can be rebuilt or is main's", async () => {
    const { app, historyRoot, worktrees } = await setup({ ".gitignore": ".env*\nnode_modules/\ndata/\n*.log\n", "index.ts": "v1\n" });
    await writeFile(join(app, ".env.shared"), "SAME=1\n");
    const conversation = await worktrees.ensure("c1", []);
    const checkout = join(conversation.cwd, "app");
    await writeFile(join(checkout, ".env.local"), "SECRET=agent\n");
    await writeFile(join(checkout, ".env.shared"), "SAME=1\n");
    await mkdir(join(checkout, "node_modules", "dep"), { recursive: true });
    await writeFile(join(checkout, "node_modules", "dep", "index.js"), "dep\n");
    await mkdir(join(checkout, "data", "node_modules"), { recursive: true });
    await writeFile(join(checkout, "data", "dev.db"), "rows\n");
    await writeFile(join(checkout, "data", "node_modules", "x.js"), "x\n");
    await writeFile(join(checkout, "debug.log"), "noise\n");

    await worktrees.retire("c1", conversation.repos, "t");

    expect(existsSync(checkout)).toBe(false);
    const [entry] = await trashEntries(historyRoot);
    expect(entry).toMatch(/^app-c1-local-files-\d{13}$/u);
    const kept = join(historyRoot, "trash", entry ?? "");
    expect(await readFile(join(kept, "files", ".env.local"), "utf8")).toBe("SECRET=agent\n");
    expect(await readFile(join(kept, "files", "data", "dev.db"), "utf8")).toBe("rows\n");
    // SAFETY: setAsideLocalFiles wrote this file in this shape; the assertions below read it field by field.
    const manifest = JSON.parse(await readFile(join(kept, KEPT_MANIFEST), "utf8")) as { paths: string[]; complete: boolean };
    expect(manifest).toMatchObject({ conversation: "c1", repo: "app", complete: true });
    expect(manifest.paths.toSorted()).toEqual([".env.local", "data/dev.db"]);
});

test("a retire with nothing at risk sets nothing aside", async () => {
    const { historyRoot, worktrees } = await setup({ ".gitignore": "node_modules/\n", "index.ts": "v1\n" });
    const conversation = await worktrees.ensure("c1", []);
    await mkdir(join(conversation.cwd, "app", "node_modules"), { recursive: true });
    await writeFile(join(conversation.cwd, "app", "node_modules", "a.js"), "a\n");
    await worktrees.retire("c1", conversation.repos, "t");
    expect(await trashEntries(historyRoot)).toEqual([]);
});

test(".worktreeinclude copies the main checkout's ignored files it names, and an unchanged copy is not kept at retire", async () => {
    const { app, historyRoot, worktrees } = await setup({
        ".gitignore": ".env*\nconfig/local.json\nsecrets/\nnode_modules/\n",
        ".worktreeinclude": "# local files\n.env*\n!.env.skip\nconfig/local.json\n../outside\n/missing.txt\nnode_modules\n",
        "config/app.json": "{}\n",
    });
    await writeFile(join(app, ".env"), "A=1\n");
    await writeFile(join(app, ".env.skip"), "B=1\n");
    await writeFile(join(app, "config", "local.json"), "{\"local\":true}\n");
    await mkdir(join(app, "node_modules", "dep"), { recursive: true });
    await writeFile(join(app, "node_modules", "dep", "index.js"), "dep\n");
    await mkdir(join(app, "secrets"), { recursive: true });
    await writeFile(join(app, "secrets", "key"), "k\n");

    const conversation = await worktrees.ensure("c1", []);
    const checkout = join(conversation.cwd, "app");

    expect(await readFile(join(checkout, ".env"), "utf8")).toBe("A=1\n");
    expect(await readFile(join(checkout, "config", "local.json"), "utf8")).toBe("{\"local\":true}\n");
    expect(existsSync(join(checkout, ".env.skip"))).toBe(false);
    expect(existsSync(join(checkout, "secrets", "key"))).toBe(false);
    // Never copied: the mirror link to main's stands there instead (isolation.ts MIRRORED_DIRS).
    expect(lstatSync(join(checkout, "node_modules")).isSymbolicLink()).toBe(true);
    expect(await sh(checkout, "status", "--porcelain")).toBe("");

    await writeFile(join(checkout, "config", "local.json"), "{\"local\":\"edited\"}\n");
    await worktrees.retire("c1", conversation.repos, "t");
    const [entry] = await trashEntries(historyRoot);
    // SAFETY: setAsideLocalFiles wrote this file in this shape.
    const manifest = JSON.parse(await readFile(join(historyRoot, "trash", entry ?? "", KEPT_MANIFEST), "utf8")) as { paths: string[] };
    expect(manifest.paths).toEqual(["config/local.json"]);
});

test("a setup hook runs only once its exact content is approved, and the next turn is told what it did", async () => {
    const { historyRoot, worktrees } = await setup({
        [CHECKOUT_HOOKS_FILE]: JSON.stringify({ setup: { command: "sh scripts/setup.sh" } }),
        "scripts/setup.sh": "echo seeded > seeded.txt\necho setup-said-this\n",
        ".gitignore": "seeded.txt\n",
    });
    const first = await worktrees.ensure("c1", []);
    expect(existsSync(join(first.cwd, "app", "seeded.txt"))).toBe(false);
    expect(takeCheckoutSetupNote("c1")?.text).toContain("has not approved it");
    const [request] = (await hookRequests(historyRoot)).requests;
    expect(request?.hooks[0]?.run).toBe("sh scripts/setup.sh");
    expect(request?.scripts.map(({ path }) => path)).toEqual(["app/scripts/setup.sh"]);

    expect(await approveHookSet(historyRoot, request?.digest ?? "")).toBe(true);
    const second = await worktrees.ensure("c2", []);
    expect(await readFile(join(second.cwd, "app", "seeded.txt"), "utf8")).toBe("seeded\n");
    const note = takeCheckoutSetupNote("c2");
    expect(note?.text).toContain("setup ran");
    expect(note?.text).toContain("setup-said-this");
    expect(takeCheckoutSetupNote("c2")).toBeUndefined();

    // A branch that edits the script is a new digest: what was approved no longer covers it.
    const hook = { command: "sh scripts/setup.sh", files: [], timeoutSeconds: 300 };
    const before = await checkoutHookSet(join(second.cwd, "app"), "app", "setup", hook);
    expect(before.digest).toBe(request?.digest ?? "");
    await writeFile(join(second.cwd, "app", "scripts", "setup.sh"), "echo changed > seeded.txt\n");
    expect((await checkoutHookSet(join(second.cwd, "app"), "app", "setup", hook)).digest).not.toBe(before.digest);
});

test("an approved archive hook that fails keeps the checkout, and revoking its approval lets the retire go", async () => {
    const { historyRoot, worktrees } = await setup({
        [CHECKOUT_HOOKS_FILE]: JSON.stringify({ archive: { command: "exit 3" } }),
        "index.ts": "v1\n",
    });
    const conversation = await worktrees.ensure("c1", []);
    // Unapproved: it does not run and holds nothing back, but asks.
    const unapproved = await worktrees.ensure("c0", []);
    await worktrees.retire("c0", unapproved.repos, "t");
    expect(existsSync(join(unapproved.cwd, "app"))).toBe(false);
    const [request] = (await hookRequests(historyRoot)).requests;
    await approveHookSet(historyRoot, request?.digest ?? "");

    await expect(worktrees.retire("c1", conversation.repos, "t")).rejects.toBeInstanceOf(ArchiveHookFailed);
    expect(existsSync(join(conversation.cwd, "app", "index.ts"))).toBe(true);

    await revokeHookSet(historyRoot, request?.digest ?? "");
    await worktrees.retire("c1", conversation.repos, "t");
    expect(existsSync(join(conversation.cwd, "app"))).toBe(false);
});

test("a scan cut short by its budget keeps what it had no time to judge whole, and says so", async () => {
    const { work, worktrees } = await setup({ ".gitignore": "data/\n.env\n", "index.ts": "v1\n" });
    const conversation = await worktrees.ensure("c1", []);
    const checkout = join(conversation.cwd, "app");
    await mkdir(join(checkout, "data", "deep"), { recursive: true });
    await writeFile(join(checkout, "data", "deep", "a.db"), "a\n");
    await writeFile(join(checkout, "data", "deep", "b.db"), "b\n");
    await writeFile(join(checkout, ".env"), "E=1\n");
    const scan = await scanAtRiskLocalFiles(checkout, join(work, "app"), defaultGit, { ...DEFAULT_SCAN_LIMITS, maxEntries: 2 });
    expect(scan).toEqual({ atRisk: [".env", "data/"], complete: false });
});

test(".worktreeinclude lines follow gitignore's anchoring and refuse paths outside the repository", () => {
    expect(parseIncludeLine(".env*")).toEqual({ glob: "**/.env*", negated: false, dirOnly: false });
    expect(parseIncludeLine("/config/local.json")).toEqual({ glob: "config/local.json", negated: false, dirOnly: false });
    expect(parseIncludeLine("!fixtures/")).toEqual({ glob: "**/fixtures", negated: true, dirOnly: true });
    expect(parseIncludeLine("# note")).toBeUndefined();
    expect(parseIncludeLine("../x")).toHaveProperty("refused");
    expect(parseIncludeLine("a/../../x")).toHaveProperty("refused");
    expect(parseIncludeLine("C:\\x")).toHaveProperty("refused");
});
