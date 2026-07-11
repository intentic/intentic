import { mkdtempSync } from "node:fs";
import { mkdir, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import type { Automation } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { type AutomationsStore, fileAutomationsStore } from "./automations-store.js";

// A store over a fresh temp path (the .intentic dir doesn't exist yet — the store must create it on write).
const tempStore = (): { store: AutomationsStore; path: string } => {
    const path = join(mkdtempSync(join(tmpdir(), "autos-")), ".intentic", "automations.json");
    return { store: fileAutomationsStore(path), path };
};

const automation = (id: string, cron = "* * * * *"): Automation => ({
    id,
    trigger: { kind: "schedule", cron },
    prompt: "check the inbox",
    enabled: true,
});

test("upsert appends, then edits by id keeping the run history", async () => {
    const { store } = tempStore();
    expect(await store.list()).toEqual([]);
    await store.upsert(automation("inbox"));
    await store.upsert(automation("standup", "0 9 * * *"));
    expect((await store.list()).map((record) => record.id)).toEqual(["inbox", "standup"]);
    await store.recordRun("inbox", { at: 1, outcome: "completed" });
    // Re-upserting the same id edits the config but keeps the recorded runs.
    await store.upsert({ ...automation("inbox", "*/5 * * * *"), enabled: false });
    const edited = await store.get("inbox");
    expect(edited?.trigger).toEqual({ kind: "schedule", cron: "*/5 * * * *" });
    expect(edited?.enabled).toBe(false);
    expect(edited?.runs).toEqual([{ at: 1, outcome: "completed" }]);
    expect(await store.list()).toHaveLength(2);
});

test("recordRun prepends newest-first, caps the history, and drops runs for removed automations", async () => {
    const { store } = tempStore();
    await store.upsert(automation("inbox"));
    for (let i = 1; i <= 25; i++) {
        await store.recordRun("inbox", { at: i, outcome: "completed" });
    }
    const runs = (await store.get("inbox"))?.runs ?? [];
    expect(runs).toHaveLength(20);
    expect(runs[0]?.at).toBe(25);
    // A run for an id that no longer exists is a no-op, not a throw.
    await store.recordRun("gone", { at: 1, outcome: "error", detail: "boom" });
    expect(await store.remove("inbox")).toBe(true);
    expect(await store.remove("inbox")).toBe(false);
});

test("a corrupt or schema-invalid manifest reads as empty rather than throwing", async () => {
    const { store, path } = tempStore();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "{ not valid json");
    expect(await store.list()).toEqual([]);
    await writeFile(path, JSON.stringify([{ id: "x", trigger: { kind: "bogus" }, prompt: "p", enabled: true, runs: [] }]));
    expect(await store.list()).toEqual([]);
});
