import { lstat } from "node:fs/promises";
import { join } from "node:path";
import { unstubbed } from "@intentic/testing";
import { call } from "@orpc/server";
import type { OrpcContext } from "../../../app-env.js";
import type { Services } from "../../../composition.js";
import { statePath } from "../../../state-paths.js";
import type { StorageRoots } from "./storage-catalog.js";
import { createStorageRoutes } from "./storage.routes.js";
import { plant, removeStorageTrees, storageTree } from "./storage.testing.js";

// The four storage procedures over a real temp tree, through oRPC's own call so the contract's schemas judge every
// input and answer: what a scan reports, what a clean frees, and what a clean refuses.

const context: OrpcContext = { headers: new Headers(), method: "POST", url: "/system/storage" };
const NOW = Date.now();
const OLD = 30 * 24 * 60 * 60 * 1000;

afterEach(removeStorageTrees);

const routesOver = (roots: StorageRoots) =>
    createStorageRoutes(
        {
            config: unstubbed<Services["config"]>("config", { historyRoot: roots.history }),
            workspace: unstubbed<Services["workspace"]>("workspace", { root: roots.workspace }),
            logger: unstubbed<Services["logger"]>("logger", { info: () => {} }),
        },
        async () => {
            throw new Error("no package store in this tree");
        },
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
    expect(await call(routesOver(roots).storage, undefined, { context })).toEqual({ scanning: false });
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
    expect(await call(routes.storage, undefined, { context })).toEqual(report);
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
    expect(rescanned.scan?.categories.map((category) => category.id)).toEqual(["workspace", "conversations", "logs"]);
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
