import { mkdtempSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import { expect, test } from "vitest";
import { type AutomationsStore, consecutiveFailures, fileAutomationsStore } from "./automations-store.js";
import { automationConfig } from "../harness/route-stores.testing.js";

// Fresh temp paths; `.intentic` doesn't exist yet, so the store must create it on write.
const tempStore = (): { store: AutomationsStore; path: string; runsPath: string } => {
    const dir = join(mkdtempSync(join(tmpdir(), "autos-")), `${STATE_DIR}`);
    const path = join(dir, "automations.json");
    const runsPath = join(dir, "automation-runs.json");
    return { store: fileAutomationsStore(path, runsPath), path, runsPath };
};

test("upsert appends, then edits by id keeping the run history", async () => {
    const { store } = tempStore();
    expect(await store.list()).toEqual([]);
    await store.upsert(automationConfig("inbox"));
    await store.upsert(automationConfig("standup", { trigger: { kind: "schedule", cron: "0 9 * * *" } }));
    expect((await store.list()).map((record) => record.id)).toEqual(["inbox", "standup"]);
    await store.recordRun("inbox", { at: 1, outcome: "completed" });
    // Re-upserting the same id edits the config but keeps the recorded runs.
    await store.upsert(automationConfig("inbox", { trigger: { kind: "schedule", cron: "*/5 * * * *" }, enabled: false }));
    const edited = await store.get("inbox");
    expect(edited?.trigger).toEqual({ kind: "schedule", cron: "*/5 * * * *" });
    expect(edited?.enabled).toBe(false);
    expect(edited?.runs).toEqual([{ at: 1, outcome: "completed" }]);
    expect(await store.list()).toHaveLength(2);
});

test("setEnabled changes only the switch on the current record", async () => {
    const { store } = tempStore();
    await store.upsert(
        automationConfig("support", {
            trigger: { kind: "listener", provider: "webchat", allowedOrigins: ["https://example.com"] },
            prompt: "answer support questions",
            webchat: { antiBot: "turnstile", turnstileSecret: "secret" },
            allowedTools: ["Read"],
        }),
    );
    await store.recordRun("support", { at: 1, outcome: "completed" });
    const before = await store.get("support");

    expect(await store.setEnabled("missing", false)).toBe(false);
    expect(await store.setEnabled("support", false)).toBe(true);
    expect(await store.get("support")).toEqual({ ...before, enabled: false });
});

test("recordRun prepends newest-first, caps the history, and drops runs for removed automations", async () => {
    const { store } = tempStore();
    await store.upsert(automationConfig("inbox"));
    for (let i = 1; i <= 25; i++) {
        await store.recordRun("inbox", { at: i, outcome: "completed" });
    }
    const runs = (await store.get("inbox"))?.runs ?? [];
    expect(runs).toHaveLength(20);
    expect(runs[0]?.at).toBe(25);
    // Recording a run for an id that no longer exists is a no-op, not a throw.
    await store.recordRun("gone", { at: 1, outcome: "error", detail: "boom" });
    expect(await store.remove("inbox")).toBe(true);
    expect(await store.remove("inbox")).toBe(false);
});

test("recording a run leaves the tracked manifest untouched and writes only the ledger", async () => {
    const { store, path, runsPath } = tempStore();
    await store.upsert(automationConfig("inbox"));
    const manifestBefore = await readFile(path, "utf8");

    await store.recordRun("inbox", { at: 1, outcome: "completed", conversationId: "cnv_1" });

    expect(await readFile(path, "utf8")).toBe(manifestBefore);
    expect(manifestBefore).not.toContain("cnv_1");
    expect(JSON.parse(await readFile(runsPath, "utf8"))).toEqual({ inbox: [{ at: 1, outcome: "completed", conversationId: "cnv_1" }] });
    expect((await store.get("inbox"))?.runs).toEqual([{ at: 1, outcome: "completed", conversationId: "cnv_1" }]);
});

test("removing an automation takes its run history with it", async () => {
    const { store, runsPath } = tempStore();
    await store.upsert(automationConfig("inbox"));
    await store.upsert(automationConfig("standup", { trigger: { kind: "schedule", cron: "0 9 * * *" } }));
    await store.recordRun("inbox", { at: 1, outcome: "completed" });
    await store.recordRun("standup", { at: 2, outcome: "completed" });

    expect(await store.remove("inbox")).toBe(true);
    expect(JSON.parse(await readFile(runsPath, "utf8"))).toEqual({ standup: [{ at: 2, outcome: "completed" }] });
});

test("an automation re-created under a used id starts with no runs", async () => {
    const { store } = tempStore();
    await store.upsert(automationConfig("inbox"));
    await store.recordRun("inbox", { at: 1, outcome: "error", detail: "boom" });
    await store.remove("inbox");

    await store.upsert(automationConfig("inbox"));
    expect((await store.get("inbox"))?.runs).toEqual([]);
});

test("a corrupt or schema-invalid manifest reads as empty rather than throwing", async () => {
    const { store, path } = tempStore();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "{ not valid json");
    expect(await store.list()).toEqual([]);
    await writeFile(
        path,
        JSON.stringify([
            { id: "x", trigger: { kind: "bogus" }, prompt: "p", models: [{ provider: "claude", model: "claude-sonnet-4-6" }], enabled: true },
        ]),
    );
    expect(await store.list()).toEqual([]);
});

// A damaged ledger only costs run history; the manifest decides an automation exists and must keep firing.
test("a corrupt ledger costs the history but still lists and fires the automations", async () => {
    const { store, runsPath } = tempStore();
    await store.upsert(automationConfig("inbox"));
    await store.recordRun("inbox", { at: 1, outcome: "completed" });
    await writeFile(runsPath, "{ not valid json");

    expect((await store.list()).map((record) => [record.id, record.runs])).toEqual([["inbox", []]]);
    // A later recordRun rebuilds the ledger from scratch.
    await store.recordRun("inbox", { at: 2, outcome: "completed" });
    expect((await store.get("inbox"))?.runs).toEqual([{ at: 2, outcome: "completed" }]);
});

// Runs are newest-first; only `error` extends the streak. `skipped` and `interrupted` end it without counting as
// failures.
test("consecutiveFailures counts errors from the newest run and stops at the first survivor", () => {
    const run = (outcome: "completed" | "skipped" | "error" | "interrupted") => ({ at: 1, outcome });
    expect(consecutiveFailures([])).toBe(0);
    expect(consecutiveFailures([run("error"), run("error"), run("completed")])).toBe(2);
    expect(consecutiveFailures([run("completed"), run("error"), run("error")])).toBe(0);
    expect(consecutiveFailures([run("error"), run("error")])).toBe(2);
    expect(consecutiveFailures([run("error"), run("skipped"), run("error")])).toBe(1);
    expect(consecutiveFailures([run("error"), run("interrupted"), run("error")])).toBe(1);
});
