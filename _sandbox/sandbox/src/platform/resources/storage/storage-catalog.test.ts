import { describe, expect, test } from "bun:test";
import { HISTORY_STATE_FILES, STORAGE_CATEGORIES, STORAGE_CLEANABILITY, WORKSPACE_STATE_FILES } from "@intentic/sandbox-contract";
import {
    categoryFolders,
    classifyStoragePath,
    isProtectedStoragePath,
    locateStoragePath,
    type StorageRootKind,
} from "./storage-catalog.js";

// The table every scan sizes by and every clean asks right before it removes a path. What matters most is the
// boundary between what may go and what may not, so these pin exact answers at that boundary.

describe("classifyStoragePath", () => {
    test("names the item a path counts toward, and whether the path is that item", () => {
        expect(classifyStoragePath("history", "trash/intentic-1789157840134/objects/pack/a.pack")).toEqual({
            category: "trash",
            item: "trash/intentic-1789157840134",
            unit: false,
            settled: true,
        });
        expect(classifyStoragePath("history", "trash/intentic-1789157840134")).toEqual({
            category: "trash",
            item: "trash/intentic-1789157840134",
            unit: true,
            settled: true,
        });
        // The category's own folder holds items; it is never one.
        expect(classifyStoragePath("history", "trash")).toEqual({ category: "trash", item: "trash", unit: false, settled: false });
    });

    test("a nested rule carves its folder out of the one around it", () => {
        expect(classifyStoragePath("history", "gits/.turbo/cache/0000effc265ff7b7.tar.zst")).toMatchObject({ category: "buildCaches", item: "gits/.turbo" });
        expect(classifyStoragePath("history", "gits/intentic/objects/pack/b.pack")).toMatchObject({ category: "repositories", item: "gits/intentic" });
        // Not settled: the folder holds both a repository and the build cache.
        expect(classifyStoragePath("history", "gits")).toEqual({ category: "repositories", item: "gits", unit: false, settled: false });

        const artifacts = ".intentic/records/artifacts";
        expect(classifyStoragePath("workspace", `${artifacts}/browser/page-2026-09-23.png`)).toEqual({
            category: "browserCaptures",
            item: `${artifacts}/browser/page-2026-09-23.png`,
            unit: true,
            settled: true,
        });
        expect(classifyStoragePath("workspace", `${artifacts}/attachments/49480a06/photo.png`).category).toBe("conversations");
        expect(classifyStoragePath("workspace", `${artifacts}/loops/fair-sage-ey2r/progress.md`).category).toBe("conversations");
        expect(classifyStoragePath("workspace", `${artifacts}/acceptance/report.md`)).toMatchObject({ category: "artifacts", item: `${artifacts}/acceptance` });
        // A folder of generated images is not one artifact: each image is.
        expect(classifyStoragePath("workspace", `${artifacts}/imagegen`)).toMatchObject({ category: "artifacts", unit: false });
        expect(classifyStoragePath("workspace", `${artifacts}/imagegen/ig_1.png`)).toMatchObject({ category: "artifacts", unit: true });

        expect(classifyStoragePath("workspace", ".intentic/local/cache/models/Qwen3.5-2B-Q4_K_M.gguf")).toMatchObject({ category: "modelWeights", unit: true });
        expect(classifyStoragePath("workspace", ".intentic/local/cache/iq/segments/0001")).toMatchObject({ category: "indexes", item: ".intentic/local/cache/iq" });
    });

    test("what no rule names falls to the workspace, the history's declared state, or nobody", () => {
        expect(classifyStoragePath("workspace", "refs/ZCode/package.json")).toEqual({ category: "workspace", item: "refs", unit: false, settled: true });
        expect(classifyStoragePath("workspace", ".intentic/secrets/auth/claude/.credentials.json")).toMatchObject({ category: "state", item: ".intentic/secrets" });
        expect(classifyStoragePath("history", "activity.jsonl").category).toBe("state");
        // A store's own backup of a file it could not parse rides that file's declaration.
        expect(classifyStoragePath("history", "account-usage.json.corrupt").category).toBe("state");
        expect(classifyStoragePath("history", "pre-conversations-db-backup-20260923/conversations.db").category).toBe("other");
        expect(classifyStoragePath("history", "conversations.db-wal").category).toBe("conversations");
        expect(classifyStoragePath("volume", "docker/overlay2/l/ABC").category).toBe("docker");
        expect(classifyStoragePath("volume", ".pnpm-store/v11/index.db").category).toBe("packageStores");
        expect(classifyStoragePath("volume", "lost+found/#12").category).toBe("other");
    });
});

describe("the state tables", () => {
    // Discovered, not listed: a state file added to either table is held to this the day it is declared.
    const declared = [
        ...WORKSPACE_STATE_FILES.map((file) => ({ root: "workspace" as StorageRootKind, file })),
        ...HISTORY_STATE_FILES.map((file) => ({ root: "history" as StorageRootKind, file })),
    ];

    test("every declared state path has a category of its own", () => {
        const unclaimed = declared.filter(({ root, file }) => classifyStoragePath(root, file.path).category === "other").map(({ file }) => file.path);
        expect(unclaimed).toEqual([]);
    });

    test("no credential or identity is cleanable, and nothing that travels is cleaned without asking", () => {
        const misfiled = declared.flatMap(({ root, file }) => {
            const cleanability = STORAGE_CLEANABILITY[classifyStoragePath(root, file.path).category];
            const allowed = file.portability === "secret" || file.portability === "identity" ? ["none"] : file.portability === "carry" ? ["none", "confirm"] : [];
            return allowed.length === 0 || allowed.includes(cleanability) ? [] : [`${file.path}: ${file.portability} is ${cleanability}`];
        });
        expect(misfiled).toEqual([]);
    });
});

describe("protection", () => {
    test("a cleanable category's items are never protected, so the table and the fence agree", () => {
        const fenced = STORAGE_CATEGORIES.filter((category) => STORAGE_CLEANABILITY[category] !== "none").flatMap((category) =>
            categoryFolders(category)
                .filter((rule) => isProtectedStoragePath(rule.root, `${rule.prefix}item`))
                .map((rule) => `${category}: ${rule.prefix}`),
        );
        expect(fenced).toEqual([]);
    });

    test("fences credentials, conversation records and live checkouts whatever category holds them", () => {
        expect(isProtectedStoragePath("history", "worktrees/fair-sage-ey2r/intentic/src/app.ts")).toBe(true);
        expect(isProtectedStoragePath("history", "overlays/fair-sage-ey2r")).toBe(true);
        expect(isProtectedStoragePath("history", "conversations.db-wal")).toBe(true);
        expect(isProtectedStoragePath("workspace", ".intentic/secrets/auth/claude/.credentials.json")).toBe(true);
        // Account state kept beside the profile folders, which a browser-profile clean would otherwise reach.
        expect(isProtectedStoragePath("workspace", ".intentic/local/browser/radarsuspam2.passkeys.json")).toBe(true);
        expect(isProtectedStoragePath("workspace", ".intentic/local/browser/saldeosmart-web.connected")).toBe(true);
        expect(isProtectedStoragePath("workspace", ".intentic/local/browser/identity")).toBe(false);
        // A root itself is never removable.
        expect(isProtectedStoragePath("history", "")).toBe(true);
    });
});

describe("locateStoragePath", () => {
    // The hosted layout: one volume holding the workspace and the history, and the nested Docker beside them.
    const roots = { workspace: "/data/work", history: "/data/history", volume: "/data" };

    test("the innermost root a path lies in answers for it", () => {
        expect(locateStoragePath(roots, "/data/work/refs/ZCode")).toEqual({ root: "workspace", rel: "refs/ZCode" });
        expect(locateStoragePath(roots, "/data/history/trash/x")).toEqual({ root: "history", rel: "trash/x" });
        expect(locateStoragePath(roots, "/data/docker/overlay2")).toEqual({ root: "volume", rel: "docker/overlay2" });
        expect(locateStoragePath(roots, "/data/work")).toEqual({ root: "workspace", rel: "" });
    });

    test("a path outside every root, or one that only shares a prefix with one, is nowhere", () => {
        expect(locateStoragePath(roots, "/etc/passwd")).toBeUndefined();
        expect(locateStoragePath({ workspace: "/work", history: "/history" }, "/workspace-backup/x")).toBeUndefined();
        expect(locateStoragePath({ workspace: "/work", history: "/history" }, "/work/../etc/passwd")).toBeUndefined();
    });
});
