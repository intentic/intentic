import { mkdtempSync } from "node:fs";
import { readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

// Until the push checks went (2026-09-28), main's red was kept in the one shape it shared with a push's: a finding with
// what a push check printed about it, decisions naming the findings they were about, and two kinds only a push red made.
test("a red kept in the shape it shared with a push's red reads back as main's red", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "ci-red-")), "ci.json");
    const finding = { id: "f", source: "CI", text: "verify-core" };
    await writeFile(
        path,
        JSON.stringify({
            secret: "s",
            conclusions: {},
            reds: {
                "web\nmain": {
                    since: 1,
                    findings: [{ ...finding, path: "src/a.ts", command: "pnpm test", recheckable: true, gate: "code", commit: { sha: "c1", subject: "Fix" } }],
                    decisions: [
                        { kind: "fix-up", conversationId: "ci-fix-web-40", at: 2 },
                        { kind: "resolved", at: 3, findings: ["f"], detail: "A later measurement no longer printed them." },
                        { kind: "dismissed", at: 4, findings: ["f"] },
                    ],
                    firstRunId: 40,
                    runId: 41,
                    count: 2,
                },
            },
        }),
    );
    expect(await fileCiStore(path).reds()).toEqual({
        "web\nmain": {
            since: 1,
            findings: [finding],
            decisions: [
                { kind: "fix-up", conversationId: "ci-fix-web-40", at: 2 },
                { kind: "reported", at: 3, detail: "A later measurement no longer printed them." },
                { kind: "reported", at: 4 },
            ],
            firstRunId: 40,
            runId: 41,
            count: 2,
            workflows: {},
            heard: [],
            turns: 0,
            changed: false,
        },
    });
});
