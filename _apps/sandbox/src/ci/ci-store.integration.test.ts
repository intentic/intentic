import { mkdtempSync } from "node:fs";
import { readFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, test } from "vitest";
import { fileCiStore } from "./ci-store.js";

const storeIn = (name: string) => fileCiStore(join(mkdtempSync(join(tmpdir(), name)), "ci.json"));

test("the webhook secret is minted once and stable across reads", async () => {
    const store = storeIn("ci-secret-");
    const first = await store.secret();
    expect(first).toMatch(/^[0-9a-f]{64}$/);
    expect(await store.secret()).toBe(first);
});

test("conclusions remember the last terminal result per repo+branch", async () => {
    const store = storeIn("ci-conclusions-");
    expect(await store.lastConclusion("web", "main")).toBeUndefined();
    await store.recordConclusion("web", "main", "failed", 1);
    expect(await store.lastConclusion("web", "main")).toBe("failed");
    // Another branch and another repo are separate streaks.
    expect(await store.lastConclusion("web", "dev")).toBeUndefined();
    await store.recordConclusion("web", "main", "success", 2);
    expect(await store.lastConclusion("web", "main")).toBe("success");
});

test("conclusions prune oldest-touched past the cap so the file cannot grow forever", async () => {
    const root = mkdtempSync(join(tmpdir(), "ci-prune-"));
    const store = fileCiStore(join(root, "ci.json"));
    for (let i = 0; i < 205; i += 1) {
        await store.recordConclusion("web", `branch-${i}`, "failed", i);
    }
    expect(await store.lastConclusion("web", "branch-0")).toBeUndefined();
    expect(await store.lastConclusion("web", "branch-204")).toBe("failed");
    const state = JSON.parse(await readFile(join(root, "ci.json"), "utf8")) as { conclusions: Record<string, unknown> };
    expect(Object.keys(state.conclusions)).toHaveLength(200);
});
