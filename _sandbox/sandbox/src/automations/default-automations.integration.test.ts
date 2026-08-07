import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PUBLISH_DRAFTS_AUTOMATION } from "@intentic/sandbox-contract";
import { FIX_DEPS_AUTOMATION } from "@intentic/sandbox-contract/chores";
import { expect, test } from "vitest";
import { fileAutomationsStore } from "./automations-store.js";
import { seedDefaultAutomations } from "./default-automations.js";

const stores = (): { automations: ReturnType<typeof fileAutomationsStore>; ledger: string } => {
    const root = mkdtempSync(join(tmpdir(), "seed-"));
    return { automations: fileAutomationsStore(join(root, "automations.json")), ledger: join(root, "automations.seeded.json") };
};

test("a fresh workspace is seeded the fix chore — enabled, held per fire, visible like any other row", async () => {
    const { automations, ledger } = stores();
    await seedDefaultAutomations(automations, ledger);
    const seeded = await automations.get(FIX_DEPS_AUTOMATION.id);
    expect(seeded).toMatchObject({
        enabled: true,
        chore: true,
        holdForSeconds: FIX_DEPS_AUTOMATION.holdForSeconds,
        trigger: { kind: "workspace", event: "deps.broken" },
    });
});

test("a fresh workspace is seeded the drafts publisher — enabled, guarded, on its sweep cron", async () => {
    const { automations, ledger } = stores();
    await seedDefaultAutomations(automations, ledger);
    const seeded = await automations.get(PUBLISH_DRAFTS_AUTOMATION.id);
    expect(seeded).toMatchObject({
        enabled: true,
        guard: PUBLISH_DRAFTS_AUTOMATION.guard,
        trigger: { kind: "schedule", cron: PUBLISH_DRAFTS_AUTOMATION.cron },
    });
    // Not a chore: it reacts to the owner's approvals, not to this codebase — it belongs in the main list.
    expect(seeded?.chore).toBeUndefined();
});

test("deleting the seed is final — the offer is made once, not on every boot", async () => {
    const { automations, ledger } = stores();
    await seedDefaultAutomations(automations, ledger);
    await automations.remove(FIX_DEPS_AUTOMATION.id);
    await seedDefaultAutomations(automations, ledger);
    expect(await automations.get(FIX_DEPS_AUTOMATION.id)).toBeUndefined();
});

test("an owner's own automation under a default's id is never overwritten", async () => {
    const { automations, ledger } = stores();
    await automations.upsert({ id: FIX_DEPS_AUTOMATION.id, trigger: { kind: "event" }, prompt: "mine", enabled: false });
    await seedDefaultAutomations(automations, ledger);
    expect((await automations.get(FIX_DEPS_AUTOMATION.id))?.prompt).toBe("mine");
    // …and it counted as answered: removing it later does not resurrect the default.
    await automations.remove(FIX_DEPS_AUTOMATION.id);
    await seedDefaultAutomations(automations, ledger);
    expect(await automations.get(FIX_DEPS_AUTOMATION.id)).toBeUndefined();
});
