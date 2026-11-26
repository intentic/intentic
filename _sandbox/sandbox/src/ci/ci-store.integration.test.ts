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
// failed push made. It was kept under `reds` then, and the newest passes under `greens`. (2026-11-26) Read now only by the
// hand-over to the extension that took main's repair over, which answers it in today's shape.
test("a failure kept in the shape it shared with a failed push's is handed over as main's failure", async () => {
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
                        { kind: "fix-up", conversationId: "fix-web-14", at: 2 },
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
    const handed = await fileCiStore(path).handOverRepair("intentic.pipelines", 9);
    expect(handed?.passes).toEqual({ "web\nmain": { CodeQL: 39 } });
    expect(handed?.failures).toEqual({
        "web\nmain": {
            since: 1,
            findings: [finding],
            decisions: [
                { kind: "fix-up", conversationId: "fix-web-14", at: 2 },
                { kind: "reported", at: 3, detail: "A later measurement no longer printed them." },
                { kind: "reported", at: 4 },
            ],
            firstRunId: 40,
            runId: 41,
            count: 2,
            workflows: {},
            spans: {},
            heard: [],
            turns: 0,
            changed: false,
        },
    });
});

// (2026-11-26) Main's repair moved to the pipelines extension: what the daemon kept of it is answered once, to whichever
// extension asks first, and leaves the file in the same write, so a second ask, or a later boot, finds nothing.
test("main's repair state is handed over once, and leaves the file as it goes", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "ci-hand-over-")), "ci.json");
    const failure = {
        since: 1,
        findings: [],
        decisions: [{ kind: "fix-up" as const, conversationId: "ci-fix-web-40", at: 2 }],
        firstRunId: 40,
        runId: 40,
        count: 1,
        workflows: { CI: 40 },
        spans: {},
        heard: ["40/7"],
        turns: 2,
        changed: true,
    };
    await writeFile(
        path,
        JSON.stringify({
            secret: "s",
            conclusions: { "web\nmain": { status: "failed", at: 3 } },
            failures: { "web\nmain": failure },
            passes: { "web\nmain": { CodeQL: 41 } },
            fleetReruns: { web: [39] },
            ownerSteps: { "ci-fix-web-40": { step: "Fill the field.", at: 4 } },
        }),
    );
    const store = fileCiStore(path);
    expect(await store.handOverRepair("intentic.pipelines", 9)).toEqual({
        failures: { "web\nmain": failure },
        passes: { "web\nmain": { CodeQL: 41 } },
        fleetReruns: { web: [39] },
        ownerSteps: { "ci-fix-web-40": { step: "Fill the field.", at: 4 } },
    });
    // SAFETY: the store has just written this file, and it writes one JSON object.
    const state = JSON.parse(await readFile(path, "utf8")) as Record<string, unknown>;
    expect(Object.keys(state).toSorted()).toEqual(["conclusions", "repairHandedOver", "secret"]);
    expect(state["repairHandedOver"]).toEqual({ extension: "intentic.pipelines", at: 9 });
    expect(await store.lastConclusion("web", "main")).toBe("failed");
    expect(await fileCiStore(path).handOverRepair("intentic.other", 10)).toBeUndefined();
});

// (2026-11-26) The extensions that take main lines' failures for their own fix agent (main-line-claims.ts): kept across
// restarts, let go of by the same extension.
test("an extension's claim on main lines is kept until it lets go", async () => {
    const path = join(mkdtempSync(join(tmpdir(), "ci-claims-")), "ci.json");
    const store = fileCiStore(path);
    expect(await store.mainLineClaims()).toEqual([]);
    await store.claimMainLines("intentic.pipelines", true, 1);
    await store.claimMainLines("intentic.pipelines", true, 2);
    expect(await fileCiStore(path).mainLineClaims()).toEqual(["intentic.pipelines"]);
    await store.claimMainLines("intentic.pipelines", false, 3);
    expect(await store.mainLineClaims()).toEqual([]);
});
