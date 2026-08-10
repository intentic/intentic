import type { Automation } from "@intentic/sandbox-contract";
import { FIX_DEPS_AUTOMATION } from "@intentic/sandbox-contract/chores";
import { z } from "zod";
import { jsonFile } from "../store/json-file.js";
import { objectParse } from "../store/unknown-keys.js";
import type { AutomationsStore } from "./automations-store.js";

/* SEEDING — the automations a workspace starts with, and the ledger that makes each a one-time offer.
 *
 * The chore book's rule is that nothing agentic runs enabled-and-hidden. The fix chore bends the first half
 * on purpose — it arrives enabled, because a broken tree costs every conversation that builds on it and the
 * moment it breaks is exactly when nobody is watching a shelf of suggestions — and keeps the second half
 * absolutely: it is an ordinary row on the Automations page, editable and deletable like anything the owner
 * made, and every fire is HELD with a visible countdown before it starts (holdForSeconds), which is the
 * per-run consent that replaces the arm-first click.
 *
 * PUBLISHING IS NOT ONE OF THESE ANY MORE, and the reason is the argument that used to justify it. It was
 * seeded enabled so the Drafts page's approve button would not be wired to nothing — which conceded the real
 * problem: a button whose meaning depended on a row in a list the owner never asked for, and which silently
 * stopped meaning anything the moment they deleted it. The daemon publishes drafts itself now
 * (drafts/drafts-publisher.ts), on a timer armed for the exact due moment rather than a cron asking "yet?"
 * every few minutes, so approval means the same thing in every workspace and there is nothing here to delete.
 *
 * THE LEDGER IS WHAT MAKES DELETION FINAL. "Seed when absent" alone would resurrect an automation on every
 * boot after the owner deleted it — an offer that cannot be refused. So each seed's id is written down once,
 * beside the automations manifest, and a recorded id is never seeded again: absence-plus-record reads as the
 * owner's decision, absence alone as a workspace that has not been offered it yet. The record travels with
 * the workspace (workspace-state.ts) for the same reason the manifest does — an export must not undo it. */

const SeededSchema = z.object({ seeded: z.array(z.string()) });

const DEFAULT_AUTOMATIONS: readonly Automation[] = [
    {
        id: FIX_DEPS_AUTOMATION.id,
        trigger: { kind: "workspace", event: FIX_DEPS_AUTOMATION.event },
        prompt: FIX_DEPS_AUTOMATION.prompt,
        guard: FIX_DEPS_AUTOMATION.guard,
        holdForSeconds: FIX_DEPS_AUTOMATION.holdForSeconds,
        chore: true,
        enabled: true,
    },
];

export const seedDefaultAutomations = async (automations: AutomationsStore, ledgerPath: string): Promise<void> => {
    const ledger = jsonFile<z.infer<typeof SeededSchema>>(ledgerPath, {
        parse: objectParse(SeededSchema),
        fallback: () => ({ seeded: [] }),
    });
    const record = await ledger.read();
    const existing = new Set((await automations.list()).map((automation) => automation.id));
    for (const automation of DEFAULT_AUTOMATIONS) {
        if (record.seeded.includes(automation.id) || existing.has(automation.id)) {
            continue;
        }
        await automations.upsert(automation);
    }
    // Every default is recorded, including ones that already existed — the owner who hand-made an automation
    // under a default's id has answered the offer too.
    const missing = DEFAULT_AUTOMATIONS.filter((automation) => !record.seeded.includes(automation.id));
    if (missing.length > 0) {
        await ledger.update((current) => ({ seeded: [...current.seeded, ...missing.map((automation) => automation.id)] }));
    }
};
