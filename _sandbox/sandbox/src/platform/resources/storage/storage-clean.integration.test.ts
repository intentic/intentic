import { link, lstat, lutimes, mkdir, readdir, rm, symlink } from "node:fs/promises";
import { join } from "node:path";
import { statePath } from "../../../state-paths.js";
import type { RunningProgram } from "./running-programs.js";
import { type CleanDeps, cleanCategory } from "./storage-clean.js";
import { plant, removeStorageTrees, storageTree } from "./storage.testing.js";

// Cleans real temp trees: every category rule is exercised against the filesystem it will meet, links and hard links
// included, and the only thing any test here ever removes is inside the tree it made.

const NOW = Date.now();
const HOUR = 60 * 60 * 1000;
const OLD = 30 * 24 * HOUR;

afterEach(removeStorageTrees);

const exists = (path: string): Promise<boolean> =>
    lstat(path).then(
        () => true,
        () => false,
    );

const depsOver = (roots: CleanDeps["roots"], over: Partial<Omit<CleanDeps, "roots">> = {}): CleanDeps => ({
    roots,
    now: () => NOW,
    programs: async () => [],
    prune: async () => {
        throw new Error("no package store in this test");
    },
    ...over,
});

describe("cleanCategory", () => {
    test("the trash goes entry by entry, its folder stays, and the freed bytes are what the files held", async () => {
        const { roots } = await storageTree();
        const trash = join(roots.history, "trash");
        await plant(join(trash, "intentic-1789157840134", "objects", "pack", "a.pack"), 1000, NOW, OLD);
        await plant(join(trash, "intentic-1789157840134", "HEAD"), 10, NOW, OLD);
        // Moved there a minute ago: the trash has no window, since nothing ever reads it again.
        await plant(join(trash, "site-fair-sage-ey2r-1789157842097", "index.html"), 500, NOW);

        expect(await cleanCategory("trash", depsOver(roots))).toEqual({ category: "trash", freedBytes: 1510, removed: 2, kept: 0, failed: 0 });
        expect(await readdir(trash)).toEqual([]);
    });

    test("logs older than a day go file by file, today's stay, and a folder the removals emptied goes with them", async () => {
        const { roots } = await storageTree();
        const logs = join(roots.history, "logs");
        await plant(join(logs, "daemon.log"), 40, NOW);
        await plant(join(logs, "terminals", "web-1-%0.log"), 300, NOW, 3 * 24 * HOUR);
        await plant(join(logs, "output-cache", "agent-3615f386.json"), 200, NOW, 2 * 24 * HOUR);
        await plant(join(logs, "output-cache", "agent-38b9509c.json"), 60, NOW, HOUR);

        expect(await cleanCategory("logs", depsOver(roots))).toEqual({ category: "logs", freedBytes: 500, removed: 2, kept: 2, failed: 0 });
        expect((await readdir(logs)).toSorted()).toEqual(["daemon.log", "output-cache"]);
        expect(await readdir(join(logs, "output-cache"))).toEqual(["agent-38b9509c.json"]);
    });

    test("an open browser's profile and every account's own files stay; an unused profile goes", async () => {
        const { roots } = await storageTree();
        const browser = statePath(roots.workspace, ".intentic/local/browser/");
        await plant(join(browser, "radarsuspam2", "Default", "Cookies"), 700, NOW, OLD);
        await plant(join(browser, "radarsuspam2.passkeys.json"), 90, NOW, OLD);
        await plant(join(browser, "radarsuspam2.connected"), 0, NOW, OLD);
        await plant(join(browser, "identity", "Default", "Cookies"), 800, NOW, OLD);
        // What a running Chromium leaves in its profile: a link to its host and pid, which resolves to nothing.
        await symlink("sandbox-1234", join(browser, "identity", "SingletonLock"));

        expect(await cleanCategory("browserProfiles", depsOver(roots))).toEqual({
            category: "browserProfiles",
            freedBytes: 700,
            removed: 1,
            kept: 3,
            failed: 0,
        });
        expect((await readdir(browser)).toSorted()).toEqual(["identity", "radarsuspam2.connected", "radarsuspam2.passkeys.json"]);
    });

    test("a link is removed as a link: what it points at, off the volumes, is untouched", async () => {
        const { roots, outside } = await storageTree();
        const precious = await plant(join(outside, "precious.txt"), 100, NOW, OLD);
        const scratch = statePath(roots.workspace, ".intentic/local/tmp/");
        await mkdir(scratch, { recursive: true });
        await symlink(outside, join(scratch, "escape"));
        await lutimes(join(scratch, "escape"), new Date(NOW - OLD), new Date(NOW - OLD));
        // A demo checkout whose own folder links back out: the recursive removal must not follow it either.
        await plant(join(scratch, "demo", "README.md"), 50, NOW, OLD);
        await symlink(outside, join(scratch, "demo", "shared"));

        expect(await cleanCategory("scratch", depsOver(roots))).toEqual({ category: "scratch", freedBytes: 50, removed: 2, kept: 0, failed: 0 });
        expect(await readdir(scratch)).toEqual([]);
        expect(await exists(precious)).toBe(true);
    });

    test("weights a running model server names stay; nobody naming them, they go", async () => {
        const { roots } = await storageTree();
        const weights = await plant(statePath(roots.workspace, ".intentic/local/cache/", "models", "Qwen3.5-2B-Q4_K_M.gguf"), 2048, NOW, OLD);
        const server: RunningProgram = { argv: ["llama-server", "-m", weights, "--port", "8081"] };

        expect(await cleanCategory("modelWeights", depsOver(roots, { programs: async () => [server] }))).toEqual({
            category: "modelWeights",
            freedBytes: 0,
            removed: 0,
            kept: 1,
            failed: 0,
        });
        expect(await exists(weights)).toBe(true);

        expect(await cleanCategory("modelWeights", depsOver(roots))).toEqual({
            category: "modelWeights",
            freedBytes: 2048,
            removed: 1,
            kept: 0,
            failed: 0,
        });
        expect(await exists(weights)).toBe(false);
    });

    test("a file still linked from elsewhere frees nothing, and its other name survives", async () => {
        const { roots } = await storageTree();
        const trashed = await plant(join(roots.history, "trash", "refs-1789157840134", "blob"), 1000, NOW, OLD);
        await mkdir(join(roots.workspace, "refs"), { recursive: true });
        await link(trashed, join(roots.workspace, "refs", "blob"));

        expect(await cleanCategory("trash", depsOver(roots))).toEqual({ category: "trash", freedBytes: 0, removed: 1, kept: 0, failed: 0 });
        expect(await exists(join(roots.workspace, "refs", "blob"))).toBe(true);
    });

    test("a package store goes to its own tool's prune, never while pnpm runs, credited with what the prune freed", async () => {
        const { roots } = await storageTree();
        const store = join(roots.history, ".pnpm-store");
        const unreferenced = await plant(join(store, "v11", "files", "00", "a"), 1000, NOW, OLD);
        await plant(join(store, "v11", "files", "01", "b"), 500, NOW, OLD);
        const pruned: string[] = [];
        const prune = async (storeDir: string): Promise<boolean> => {
            pruned.push(storeDir);
            await rm(unreferenced);
            return true;
        };
        const installing: RunningProgram = { argv: ["node", "/usr/local/share/pnpm/pnpm.cjs", "install"] };

        expect(await cleanCategory("packageStores", depsOver(roots, { prune, programs: async () => [installing] }))).toEqual({
            category: "packageStores",
            freedBytes: 0,
            removed: 0,
            kept: 1,
            failed: 0,
        });
        expect(pruned).toEqual([]);

        expect(await cleanCategory("packageStores", depsOver(roots, { prune }))).toEqual({
            category: "packageStores",
            freedBytes: 1000,
            removed: 1,
            kept: 0,
            failed: 0,
        });
        expect(pruned).toEqual([store]);
    });

    test("a category that may not be cleaned loses nothing, even asked directly", async () => {
        const { roots } = await storageTree();
        const checkout = await plant(join(roots.history, "worktrees", "fair-sage-ey2r", "intentic", "README.md"), 100, NOW, OLD);

        expect(await cleanCategory("checkouts", depsOver(roots))).toEqual({ category: "checkouts", freedBytes: 0, removed: 0, kept: 1, failed: 0 });
        expect(await exists(checkout)).toBe(true);
    });
});
