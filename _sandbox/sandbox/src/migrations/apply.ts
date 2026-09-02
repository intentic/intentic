import { errorMessage } from "@intentic/base/errors";
import { type Automation, type Capability, type MigrationReport, type SkillDraft, CapabilitySchema } from "@intentic/sandbox-contract";
import type { PlannedItem, SourcePlan } from "./adapter-shared.js";
import { mergeFenced } from "./merge.js";

/* THE APPLY LOOP, the ticked items of a re-derived plan, landed one by one through the same write paths the
 * ordinary surfaces use, into a report that says what landed, what did not, and what still needs a person.
 *
 * PER-ITEM FAILURE IS THE UNIT. A migration walks a lived-in home directory, and any one item can be the odd
 * one out, a skill whose text trips a filesystem limit, an env store that is not there yet. Failing the whole
 * import over it would throw away the forty items that were fine; each failure becomes a `failed` row with the
 * reason instead, and the loop keeps walking.
 *
 * THE WHOLE THING IS RE-RUNNABLE, and that is a property to preserve when extending it: memory lands through
 * idempotent fences, skills and automations are upserts, an existing capability id is refused rather than
 * overwritten. So "fix the blocker and run the import again, ticking what failed" is always a safe answer.
 *
 * Deliberately narrow deps rather than Services: everything here is decided by the plan, and the six functions
 * below are the complete surface a migration is allowed to write through, auditable at a glance, stubbable in
 * a test without composing a daemon. */

// Thrown by `setSecret` when there is no env store to write into (DevOps inactive). Typed so the loop can word
// the failure as the precondition it is, rather than as breakage.
export class SecretsInactiveError extends Error {
    constructor() {
        super("there is no env secret store until DevOps is active: activate it, then run the import again with just the secret items");
    }
}

export interface MigrationDeps {
    // Workspace-root-relative, forward-slash. Undefined ⇒ no such file (memory merges start from empty).
    readonly readWorkspaceFile: (relPath: string) => Promise<string | undefined>;
    readonly writeWorkspaceFile: (relPath: string, content: string) => Promise<void>;
    // Write + enable + reconcile in one call, the same trio the skills route refuses to let a caller sequence.
    readonly saveSkill: (skill: SkillDraft) => Promise<void>;
    readonly upsertAutomation: (automation: Automation) => Promise<void>;
    // Runs the kind's handler apply and records the manifest entry. Must refuse an id that already exists,
    // a migration lands beside nothing, never over something.
    readonly addCapability: (capability: Capability) => Promise<void>;
    readonly setSecret: (key: string, value: string) => Promise<void>;
}

// The same two files the web's paste importer writes. Claude reads one, everything AGENTS-shaped the other.
export const MEMORY_FILES = ["CLAUDE.md", "AGENTS.md"] as const;

// A capability with its credential fields withheld, re-parsed, because the schema is what says the keyless
// remainder is still a valid config (they are optional fields on every kind the adapters emit).
const withoutSecrets = (capability: Capability, secretFields: readonly string[]): Capability =>
    CapabilitySchema.parse({
        ...capability,
        config: Object.fromEntries(Object.entries(capability.config).filter(([key]) => !secretFields.includes(key))),
    });

export const applyMigration = async (
    deps: MigrationDeps,
    plan: SourcePlan,
    selection: { readonly items: readonly string[]; readonly includeSecrets: boolean },
): Promise<MigrationReport> => {
    const wanted = new Set(selection.items);
    const applied: MigrationReport["applied"] = [];
    const failed: MigrationReport["failed"] = [];
    const needsAction = [...plan.needsAction];
    const withheld: string[] = [];

    const applyOne = async (planned: PlannedItem): Promise<void> => {
        const step = planned.apply;
        switch (step.target) {
            case "memory": {
                for (const file of MEMORY_FILES) {
                    const existing = (await deps.readWorkspaceFile(file)) ?? "";
                    await deps.writeWorkspaceFile(file, mergeFenced(existing, step.fence, step.body));
                }
                return;
            }
            case "skill": {
                await deps.saveSkill(step.skill);
                return;
            }
            case "automation": {
                await deps.upsertAutomation(step.automation);
                return;
            }
            case "capability": {
                if (selection.includeSecrets || step.secretFields.length === 0) {
                    await deps.addCapability(step.capability);
                    return;
                }
                await deps.addCapability(withoutSecrets(step.capability, step.secretFields));
                needsAction.push({
                    subject: `Enter the key for "${step.capability.id}"`,
                    detail: "It was imported without secrets, so the connection landed keyless, open its card and add the credential.",
                });
                return;
            }
            case "secret": {
                await deps.setSecret(step.key, step.value);
                return;
            }
            case "file": {
                for (const file of step.files) {
                    await deps.writeWorkspaceFile(file.relPath, file.content.toString("utf8"));
                }
                return;
            }
        }
    };

    for (const planned of plan.planned) {
        if (!wanted.has(planned.item.id)) {
            continue;
        }
        // Withheld, not failed: the owner said "without secrets", and this is that choice landing, reported
        // once below rather than as a row of red per key.
        if (planned.apply.target === "secret" && !selection.includeSecrets) {
            withheld.push(planned.apply.key);
            continue;
        }
        try {
            await applyOne(planned);
            applied.push({ id: planned.item.id, target: planned.item.target, label: planned.item.label });
        } catch (error) {
            failed.push({ id: planned.item.id, label: planned.item.label, error: errorMessage(error) });
        }
    }

    if (withheld.length > 0) {
        needsAction.push({
            subject: "Secrets withheld",
            detail: `Imported without secrets, so these stayed behind: ${withheld.join(", ")}. Re-run the import with secrets on, or enter them by hand.`,
        });
    }
    return { applied, failed, refused: [...plan.refused], needsAction };
};
