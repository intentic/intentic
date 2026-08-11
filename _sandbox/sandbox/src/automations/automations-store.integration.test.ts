import { mkdtempSync } from "node:fs";
import { mkdir, readFile, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import type { Automation } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { type AutomationsStore, consecutiveFailures, fileAutomationsStore } from "./automations-store.js";

// A store over fresh temp paths (the .intentic dir doesn't exist yet — the store must create it on write).
const tempStore = (): { store: AutomationsStore; path: string; runsPath: string } => {
    const dir = join(mkdtempSync(join(tmpdir(), "autos-")), `${STATE_DIR}`);
    const path = join(dir, "automations.json");
    const runsPath = join(dir, "automation-runs.json");
    return { store: fileAutomationsStore(path, runsPath), path, runsPath };
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

test("setEnabled changes only the switch on the current record", async () => {
    const { store } = tempStore();
    await store.upsert({
        id: "support",
        trigger: { kind: "listener", provider: "webchat", allowedOrigins: ["https://example.com"] },
        prompt: "answer support questions",
        webchat: { antiBot: "turnstile", turnstileSecret: "secret" },
        allowedTools: ["Read"],
        enabled: true,
    });
    await store.recordRun("support", { at: 1, outcome: "completed" });
    const before = await store.get("support");

    expect(await store.setEnabled("missing", false)).toBe(false);
    expect(await store.setEnabled("support", false)).toBe(true);
    expect(await store.get("support")).toEqual({ ...before, enabled: false });
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

/* THE POINT OF THE SPLIT, asserted on the bytes rather than on the read model: the manifest is one of the few
 * things under `.intentic` the root repo tracks, and an automation firing three times a day used to rewrite it
 * three times a day — committing run timestamps and conversation ids beside the prompt they belonged to. A run
 * must land entirely in the untracked ledger, leaving the reviewed file byte-identical. */
test("recording a run leaves the tracked manifest untouched and writes only the ledger", async () => {
    const { store, path, runsPath } = tempStore();
    await store.upsert(automation("inbox"));
    const manifestBefore = await readFile(path, "utf8");

    await store.recordRun("inbox", { at: 1, outcome: "completed", conversationId: "cnv_1" });

    expect(await readFile(path, "utf8")).toBe(manifestBefore);
    expect(manifestBefore).not.toContain("cnv_1");
    expect(JSON.parse(await readFile(runsPath, "utf8"))).toEqual({ inbox: [{ at: 1, outcome: "completed", conversationId: "cnv_1" }] });
    // …and the store still hands its callers the joined record, which is all anything above it ever sees.
    expect((await store.get("inbox"))?.runs).toEqual([{ at: 1, outcome: "completed", conversationId: "cnv_1" }]);
});

test("removing an automation takes its run history with it", async () => {
    const { store, runsPath } = tempStore();
    await store.upsert(automation("inbox"));
    await store.upsert(automation("standup", "0 9 * * *"));
    await store.recordRun("inbox", { at: 1, outcome: "completed" });
    await store.recordRun("standup", { at: 2, outcome: "completed" });

    expect(await store.remove("inbox")).toBe(true);
    // The ledger keeps no entry for an id the manifest no longer has, so it cannot grow forever.
    expect(JSON.parse(await readFile(runsPath, "utf8"))).toEqual({ standup: [{ at: 2, outcome: "completed" }] });
});

// Re-using the id of a deleted automation starts a fresh history rather than inheriting the old one's past —
// the hole the two separately-queued files leave, closed by upsert rather than by a lock across both.
test("an automation re-created under a used id starts with no runs", async () => {
    const { store } = tempStore();
    await store.upsert(automation("inbox"));
    await store.recordRun("inbox", { at: 1, outcome: "error", detail: "boom" });
    await store.remove("inbox");

    await store.upsert(automation("inbox"));
    expect((await store.get("inbox"))?.runs).toEqual([]);
});

test("a corrupt or schema-invalid manifest reads as empty rather than throwing", async () => {
    const { store, path } = tempStore();
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, "{ not valid json");
    expect(await store.list()).toEqual([]);
    await writeFile(path, JSON.stringify([{ id: "x", trigger: { kind: "bogus" }, prompt: "p", enabled: true }]));
    expect(await store.list()).toEqual([]);
});

/* The asymmetry between the two files: a damaged ledger costs the run history and nothing else, because the
 * manifest is what decides an automation exists and the scheduler must keep firing it. Reading a broken ledger
 * as an absent manifest would silently stop every automation in the sandbox. */
test("a corrupt ledger costs the history but still lists and fires the automations", async () => {
    const { store, runsPath } = tempStore();
    await store.upsert(automation("inbox"));
    await store.recordRun("inbox", { at: 1, outcome: "completed" });
    await writeFile(runsPath, "{ not valid json");

    expect((await store.list()).map((record) => [record.id, record.runs])).toEqual([["inbox", []]]);
    // The next recorded run rebuilds it, which is why nothing asks the owner to repair this file.
    await store.recordRun("inbox", { at: 2, outcome: "completed" });
    expect((await store.get("inbox"))?.runs).toEqual([{ at: 2, outcome: "completed" }]);
});

/* The streak the spin-loop guard reads. Runs arrive newest-first, and only `error` keeps a streak alive:
 * `skipped` is a guard working as configured and `interrupted` is the daemon dying under the fire — counting
 * either would quarantine automations that are perfectly healthy. */
test("consecutiveFailures counts errors from the newest run and stops at the first survivor", () => {
    const run = (outcome: "completed" | "skipped" | "error" | "interrupted") => ({ at: 1, outcome });
    expect(consecutiveFailures([])).toBe(0);
    expect(consecutiveFailures([run("error"), run("error"), run("completed")])).toBe(2);
    expect(consecutiveFailures([run("completed"), run("error"), run("error")])).toBe(0);
    // Every run on record failed — the streak is as long as the history can say, which is the honest ceiling.
    expect(consecutiveFailures([run("error"), run("error")])).toBe(2);
    // A guard saying no is not a failure, and neither is a restart.
    expect(consecutiveFailures([run("error"), run("skipped"), run("error")])).toBe(1);
    expect(consecutiveFailures([run("error"), run("interrupted"), run("error")])).toBe(1);
});
