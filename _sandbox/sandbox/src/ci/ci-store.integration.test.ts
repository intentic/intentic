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

// Until the push checks went (2026-09-28), main's failure was kept in the one shape it shared with a failed push's: a
// finding with what a push check printed about it, decisions naming the findings they were about, and two kinds only a
// failed push made. It was kept under `reds` then, and the newest passes under `greens`.
test("a failure kept in the shape it shared with a failed push's reads back as main's failure", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "ci-failure-")), "ci.json");
    const finding = { id: "f", source: "CI", text: "verify-core" };
    await writeFile(
        path,
        JSON.stringify({
            secret: "s",
            conclusions: {},
            reds: {
                "web\nmain": {
                    since: 1,
                    findings: [
                        {
                            ...finding,
                            path: "src/a.ts",
                            command: "pnpm test",
                            recheckable: true,
                            gate: "code",
                            commit: { sha: "c1", subject: "Fix" },
                        },
                    ],
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
            greens: { "web\nmain": { CodeQL: 39 } },
        }),
    );
    const store = fileCiStore(path);
    expect(await store.passes("web", "main")).toEqual({ CodeQL: 39 });
    expect(await store.failures()).toEqual({
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

// Written under today's names, and read back by them: nothing of main's failure is kept under the names it had.
test("a failure and a pass are kept as failures and passes", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "ci-names-")), "ci.json");
    const store = fileCiStore(path);
    await store.failure("web", "main", () => ({
        since: 1,
        findings: [],
        decisions: [{ kind: "spent", reason: "turn-failed", at: 2, detail: "Its fix agent's turn failed." }],
        firstRunId: 40,
        runId: 40,
        count: 1,
        workflows: { CI: 40 },
        heard: ["40/7"],
        turns: 1,
        changed: false,
    }));
    await store.recordPass("web", "main", "CodeQL", 41);
    await store.recordPass("web", "main", "CodeQL", 39);

    // SAFETY: the store has just written this file, and it writes one JSON object.
    const state = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    expect(Object.keys(state)).toEqual(["secret", "conclusions", "failures", "passes"]);
    expect(state["passes"]).toEqual({ "web\nmain": { CodeQL: 41 } });
    expect((await store.failures())["web\nmain"]?.decisions).toEqual([
        { kind: "spent", reason: "turn-failed", at: 2, detail: "Its fix agent's turn failed." },
    ]);
});
