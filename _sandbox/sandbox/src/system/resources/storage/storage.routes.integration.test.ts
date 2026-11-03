import { checkoutSpace } from "./checkout-space.js";
import { defaultGit } from "@intentic/base/git";
import { lstat, mkdir, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { unstubbed } from "@intentic/testing";
import { call } from "@orpc/server";
import type { OrpcContext } from "../../../app-env.js";
import type { Services } from "../../../composition.js";
import { statePath } from "../../../state-paths.js";
import type { StorageRoots } from "./storage-catalog.js";
import { createStorageRoutes } from "./storage.routes.js";
import { type CheckoutActions, CheckoutActionRefused } from "./checkout-usage.js";
import { plant, removeStorageTrees, storageTree } from "./storage.testing.js";

// The four storage procedures over a real temp tree, through oRPC's own call so the contract's schemas judge every
// input and answer: what a scan reports, what a clean frees, and what a clean refuses.

const context: OrpcContext = { headers: new Headers(), method: "POST", url: "/system/storage" };
const NOW = Date.now();
const OLD = 30 * 24 * 60 * 60 * 1000;

afterEach(removeStorageTrees);

// A `target` folder inside a checkout is build output here, and every one may go.
const anyTarget = {
    detect: async (dir: string) => basename(dir) === "target",
    reapable: () => true,
    reap: async () => ({ removed: 0, failed: 0 }),
};

const routesOver = (roots: StorageRoots, checkouts?: CheckoutActions) =>
    createStorageRoutes(
        {
            config: unstubbed<Services["config"]>("config", { historyRoot: roots.history }),
            workspace: unstubbed<Services["workspace"]>("workspace", { root: roots.workspace }),
            logger: unstubbed<Services["logger"]>("logger", { info: () => {}, debug: () => {} }),
        },
        async () => {
            throw new Error("no package store in this tree");
        },
        checkouts === undefined ? undefined : anyTarget,
        checkouts,
    );

// A tree with one of each kind of answer: a cleanable category, a safe one with a part too recent, and state.
const plantSandbox = async (roots: StorageRoots): Promise<void> => {
    await plant(join(roots.history, "trash", "intentic-1789157840134", "HEAD"), 3000, NOW, OLD);
    await plant(join(roots.history, "logs", "daemon.log"), 50, NOW);
    await plant(join(roots.history, "logs", "terminals", "web-1-%0.log"), 100, NOW, OLD);
    await plant(join(roots.workspace, "refs", "ZCode", "README.md"), 700, NOW, OLD);
    await plant(statePath(roots.workspace, ".intentic/records/sessions/claude/", "projects", "work", "a.jsonl"), 400, NOW, OLD);
};

test("before any scan the report holds none, and nothing is running", async () => {
    const { roots } = await storageTree();
    const report = await call(routesOver(roots).storage, undefined, { context });
    expect(report).toEqual({
        scanning: false,
        repositoryCheckouts: [],
        historyDisk: {
            freeBytes: expect.any(Number),
            totalBytes: expect.any(Number),
            floorBytes: expect.any(Number),
            low: expect.any(Boolean),
        },
    });
    const disk = report.historyDisk!;
    expect({ floorBytes: disk.floorBytes, allowed: !disk.low }).toEqual(checkoutSpace(disk, 0));
});

test("a scan sizes every category, names its biggest parts, and says what a clean would free now", async () => {
    const { roots } = await storageTree();
    await plantSandbox(roots);
    const routes = routesOver(roots);

    const report = await call(routes.scanStorage, undefined, { context });
    expect(report.scanning).toBe(false);
    expect(report.scan).toMatchObject({
        outcome: "complete",
        unreadable: 0,
        disk: { usedBytes: expect.any(Number), totalBytes: expect.any(Number) },
    });
    expect(report.scan?.categories).toEqual([
        {
            id: "trash",
            cleanability: "confirm",
            bytes: 3000,
            files: 1,
            cleanableBytes: 3000,
            items: [{ path: join(roots.history, "trash", "intentic-1789157840134"), bytes: 3000 }],
        },
        { id: "workspace", cleanability: "none", bytes: 700, files: 1, items: [{ path: join(roots.workspace, "refs"), bytes: 700 }] },
        {
            id: "conversations",
            cleanability: "none",
            bytes: 400,
            files: 1,
            items: [{ path: statePath(roots.workspace, ".intentic/records/sessions/claude/"), bytes: 400 }],
        },
        {
            id: "logs",
            cleanability: "safe",
            bytes: 150,
            files: 2,
            // Today's daemon.log stays whatever a clean does.
            cleanableBytes: 100,
            items: [
                { path: join(roots.history, "logs", "terminals"), bytes: 100 },
                { path: join(roots.history, "logs", "daemon.log"), bytes: 50 },
            ],
        },
    ]);
    // The last scan is what a later read answers with, walking nothing.
    const reread = await call(routes.storage, undefined, { context });
    expect(reread.scan).toEqual(report.scan);
    expect(reread.scanning).toBe(false);
    expect(reread.repositoryCheckouts).toEqual([]);
});

test("a clean frees what the scan said it would, and the next scan no longer counts it", async () => {
    const { roots } = await storageTree();
    await plantSandbox(roots);
    const routes = routesOver(roots);
    await call(routes.scanStorage, undefined, { context });

    expect(await call(routes.cleanStorage, { category: "trash" }, { context })).toEqual({
        category: "trash",
        freedBytes: 3000,
        removed: 1,
        kept: 0,
        failed: 0,
    });
    const rescanned = await call(routes.scanStorage, undefined, { context });
    // The first scan, kept on the history volume, is daemon state the rescan rightly counts; its size is the JSON's.
    const counted = rescanned.scan?.categories.map((category) => category.id).filter((id) => id !== "state");
    expect(counted).toEqual(["workspace", "conversations", "logs"]);
});

test("a category that may not be cleaned is refused by name, and nothing in it moves", async () => {
    const { roots } = await storageTree();
    const checkout = await plant(join(roots.history, "worktrees", "fair-sage-ey2r", "intentic", "README.md"), 100, NOW, OLD);
    const routes = routesOver(roots);

    await expect(call(routes.cleanStorage, { category: "checkouts" }, { context })).rejects.toMatchObject({
        code: "BAD_REQUEST",
        message: "nothing in checkouts may be removed from here",
    });
    expect((await lstat(checkout)).size).toBe(100);
});

test("a category the contract does not know is refused before anything runs", async () => {
    const { roots } = await storageTree();
    await expect(call(routesOver(roots).cleanStorage, { category: "everything" } as never, { context })).rejects.toMatchObject({
        code: "BAD_REQUEST",
    });
});


test("Storage exposes each live repository's committed checkout cost, changing with HEAD", async () => {
    const { roots } = await storageTree();
    const repo = join(roots.workspace, "backup");
    await mkdir(repo);
    await defaultGit(repo, ["init", "-q"]);
    await writeFile(join(repo, "data"), "123456");
    await defaultGit(repo, ["add", "data"]);
    const commit = () => defaultGit(repo, ["-c", "user.name=test", "-c", "user.email=test@example.invalid", "commit", "-qm", "data"]);
    await commit();
    const head = (await defaultGit(repo, ["rev-parse", "HEAD"])).stdout.trim();
    const routes = routesOver(roots);
    expect((await call(routes.storage, undefined, { context })).repositoryCheckouts).toEqual([{ repo: "backup", head, bytes: 6 }]);
    await writeFile(join(repo, "data"), "12345678");
    expect((await call(routes.storage, undefined, { context })).repositoryCheckouts).toEqual([{ repo: "backup", head, bytes: 6 }]);
    await defaultGit(repo, ["add", "data"]);
    await commit();
    const next = (await defaultGit(repo, ["rev-parse", "HEAD"])).stdout.trim();
    expect((await call(routes.storage, undefined, { context })).repositoryCheckouts).toEqual([{ repo: "backup", head: next, bytes: 8 }]);
});

test("every conversation directory is listed with where its conversation stands, and a refused press says why", async () => {
    const { roots } = await storageTree();
    await plant(join(roots.history, "worktrees", "c1", "app", "src", "main.rs"), 300, NOW, OLD);
    await plant(join(roots.history, "worktrees", "c1", "app", "target", "debug", "app"), 2000, NOW, OLD);
    await plant(join(roots.history, "overlays", "c1", "node_modules", "left-pad", "index.js"), 100, NOW, OLD);
    // A shared Cargo target's layer: build output of c1's, not its checkout.
    await plant(join(roots.history, "overlays", "c1", "target", "upper", "debug", "app"), 400, NOW, OLD);
    await plant(join(roots.history, "worktrees", "gone", "README.md"), 50, NOW, OLD);
    await plant(join(roots.history, "worktrees", "stray", "README.md"), 10, NOW, OLD);
    const pressed: string[] = [];
    const routes = routesOver(roots, {
        factsOf: async (id) => {
            if (id === "gone") {
                return undefined;
            }
            return id === "stray"
                ? { state: "leftover", reapable: false, releasable: false, trashable: true }
                : { state: "idle", title: "Fix the login bug", updatedAt: 5, reapable: true, releasable: true, trashable: false };
        },
        clean: async (id) => {
            pressed.push(`clean ${id}`);
            return { id, removed: ["app/target"] };
        },
        release: async () => {
            throw new CheckoutActionRefused("a turn is under way in it");
        },
        trash: async (id) => void pressed.push(`trash ${id}`),
    });

    const report = await call(routes.scanStorage, undefined, { context });
    expect(report.scan?.checkouts).toEqual([
        { id: "c1", bytes: 300, buildOutputBytes: 2400, overlayBytes: 100 },
        { id: "gone", bytes: 50, buildOutputBytes: 0, overlayBytes: 0 },
        { id: "stray", bytes: 10, buildOutputBytes: 0, overlayBytes: 0 },
    ]);
    // `gone` left the disk after the scan: no row to press on.
    expect(report.checkouts).toEqual([
        {
            id: "c1",
            bytes: 300,
            buildOutputBytes: 2400,
            overlayBytes: 100,
            state: "idle",
            title: "Fix the login bug",
            updatedAt: 5,
            can: { cleanBuildOutput: true, release: true, trash: false },
        },
        { id: "stray", bytes: 10, buildOutputBytes: 0, overlayBytes: 0, state: "leftover", can: { cleanBuildOutput: false, release: false, trash: true } },
    ]);
    expect(await call(routes.pressCheckout, { id: "c1", press: "cleanBuildOutput" }, { context })).toEqual({ id: "c1", removed: ["app/target"] });
    expect(await call(routes.pressCheckout, { id: "stray", press: "trash" }, { context })).toEqual({ id: "stray", removed: [] });
    await expect(call(routes.pressCheckout, { id: "c1", press: "release" }, { context })).rejects.toMatchObject({
        code: "CONFLICT",
        message: "a turn is under way in it",
    });
    expect(pressed).toEqual(["clean c1", "trash stray"]);
});

test("a sandbox that keeps no checkouts answers a press as not found", async () => {
    const { roots } = await storageTree();
    await expect(call(routesOver(roots).pressCheckout, { id: "c1", press: "release" }, { context })).rejects.toMatchObject({ code: "NOT_FOUND" });
});
