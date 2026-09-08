import { errorMessage } from "@intentic/base/errors";
import { MEMORY_FILE } from "@intentic/constants";
import { type ArrivalReport, type Capability, type SkillDraft, CapabilitySchema } from "@intentic/sandbox-contract";
import type { MigratedAutomation, PlannedItem, SourcePlan } from "./adapter-shared.js";
import { mergeFenced } from "./merge.js";

// Applies a plan's ticked items one by one into a report of what landed, failed, or needs a person. Per-item failure is
// the unit, so one bad item never costs the rest; re-runnable, since fences and upserts are idempotent and an existing
// capability id refuses rather than overwrites. Deps are narrowed to six auditable functions, not full Services.

// Thrown by `setSecret` when there's no env store to write into (DevOps inactive); typed so the loop reports it as a
// precondition, not breakage.
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
    // Fills the job's model ladder, unknowable to the archive, from what this sandbox has connected (assistants.ts).
    readonly upsertAutomation: (automation: MigratedAutomation) => Promise<void>;
    // Applies the kind's handler and records the manifest entry; must refuse an existing id rather than overwrite it.
    readonly addCapability: (capability: Capability) => Promise<void>;
    readonly setSecret: (key: string, value: string) => Promise<void>;
}


// Re-parses a capability with credential fields withheld; the schema is what confirms the keyless remainder is still
// valid.
const withoutSecrets = (capability: Capability, secretFields: readonly string[]): Capability =>
    CapabilitySchema.parse({
        ...capability,
        config: Object.fromEntries(Object.entries(capability.config).filter(([key]) => !secretFields.includes(key))),
    });

export const applyMigration = async (
    deps: MigrationDeps,
    plan: SourcePlan,
    selection: { readonly items: readonly string[]; readonly includeSecrets: boolean },
): Promise<ArrivalReport> => {
    const wanted = new Set(selection.items);
    const applied: ArrivalReport["applied"] = [];
    const failed: ArrivalReport["failed"] = [];
    const needsAction = [...plan.needsAction];
    const withheld: string[] = [];

    const applyOne = async (planned: PlannedItem): Promise<void> => {
        const step = planned.apply;
        switch (step.target) {
            case "memory": {
                // One file, the same one the web's paste importer writes and the daemon composes into every turn.
                const existing = (await deps.readWorkspaceFile(MEMORY_FILE)) ?? "";
                await deps.writeWorkspaceFile(MEMORY_FILE, mergeFenced(existing, step.fence, step.body));
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
        // Withheld, not failed: the owner chose no secrets; reported once below, not as a red row per key.
        if (planned.apply.target === "secret" && !selection.includeSecrets) {
            withheld.push(planned.apply.key);
            continue;
        }
        try {
            await applyOne(planned);
            applied.push({ id: planned.item.id, group: planned.item.group, label: planned.item.label });
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
