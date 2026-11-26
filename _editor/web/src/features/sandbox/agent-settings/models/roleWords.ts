import {
    type CoreModelRole,
    CORE_MODEL_ROLES,
    EXTENSION_ROLES_BEFORE_CONTRIBUTIONS,
    type ModelRoleSpec,
    type PresetSetup,
} from "@intentic/sandbox-contract/models/model-roles";
import { t } from "@intentic/ui/i18n";

// The contract names each of the sandbox's own jobs in English, for the daemon and the settings file as much as for the
// screen, and an extension names its own in its manifest (`contributes.modelRoles`). These are the settings page's words
// for the sandbox's jobs, keyed by the wire-stable id; roleWords.test.ts holds the English copy equal to the contract's,
// so a renamed job cannot go on being shown under its old translation. (2026-11-26) The six jobs that moved to their
// extensions' manifests keep their translations while the words they are served with are still the ones translated: an
// extension that renames its job is shown in its own words.

type TranslatedRole = CoreModelRole | (typeof EXTENSION_ROLES_BEFORE_CONTRIBUTIONS)[number]["id"];

const LABELS: Readonly<Record<TranslatedRole, () => string>> = {
    "commit-message": () => t(`sandbox.modelRoles.commitMessage.label`),
    "session-title": () => t(`sandbox.modelRoles.sessionTitle.label`),
    "handoff-summary": () => t(`sandbox.modelRoles.handoffSummary.label`),
    "safety-judge": () => t(`sandbox.modelRoles.safetyJudge.label`),
    "loop-verdict": () => t(`sandbox.modelRoles.loopVerdict.label`),
    "model-router": () => t(`sandbox.modelRoles.modelRouter.label`),
    "subagent-sizing": () => t(`sandbox.modelRoles.subagentSizing.label`),
    "pipeline-fix": () => t(`sandbox.modelRoles.pipelineFix.label`),
    "deployment-fix": () => t(`sandbox.modelRoles.deploymentFix.label`),
    "workflow-fix": () => t(`sandbox.modelRoles.workflowFix.label`),
    "maintenance-chore": () => t(`sandbox.modelRoles.maintenanceChore.label`),
    "refactor-run": () => t(`sandbox.modelRoles.refactorRun.label`),
    "documentation-run": () => t(`sandbox.modelRoles.documentationRun.label`),
    "acceptance-run": () => t(`sandbox.modelRoles.acceptanceRun.label`),
    "approval-queue": () => t(`sandbox.modelRoles.approvalQueue.label`),
    "extension-review": () => t(`sandbox.modelRoles.extensionReview.label`),
    "loop-iteration": () => t(`sandbox.modelRoles.loopIteration.label`),
    "spoken-reply": () => t(`sandbox.modelRoles.spokenReply.label`),
};

const BLURBS: Readonly<Record<TranslatedRole, () => string>> = {
    "commit-message": () => t(`sandbox.modelRoles.commitMessage.blurb`),
    "session-title": () => t(`sandbox.modelRoles.sessionTitle.blurb`),
    "handoff-summary": () => t(`sandbox.modelRoles.handoffSummary.blurb`),
    "safety-judge": () => t(`sandbox.modelRoles.safetyJudge.blurb`),
    "loop-verdict": () => t(`sandbox.modelRoles.loopVerdict.blurb`),
    "model-router": () => t(`sandbox.modelRoles.modelRouter.blurb`),
    "subagent-sizing": () => t(`sandbox.modelRoles.subagentSizing.blurb`),
    "pipeline-fix": () => t(`sandbox.modelRoles.pipelineFix.blurb`),
    "deployment-fix": () => t(`sandbox.modelRoles.deploymentFix.blurb`),
    "workflow-fix": () => t(`sandbox.modelRoles.workflowFix.blurb`),
    "maintenance-chore": () => t(`sandbox.modelRoles.maintenanceChore.blurb`),
    "refactor-run": () => t(`sandbox.modelRoles.refactorRun.blurb`),
    "documentation-run": () => t(`sandbox.modelRoles.documentationRun.blurb`),
    "acceptance-run": () => t(`sandbox.modelRoles.acceptanceRun.blurb`),
    "approval-queue": () => t(`sandbox.modelRoles.approvalQueue.blurb`),
    "extension-review": () => t(`sandbox.modelRoles.extensionReview.blurb`),
    "loop-iteration": () => t(`sandbox.modelRoles.loopIteration.blurb`),
    "spoken-reply": () => t(`sandbox.modelRoles.spokenReply.blurb`),
};

// The English each translation is of, by id.
const ENGLISH = new Map<string, Pick<ModelRoleSpec, `label` | `blurb`>>([...CORE_MODEL_ROLES, ...EXTENSION_ROLES_BEFORE_CONTRIBUTIONS].map((role) => [role.id, role]));
const translatedRole = (id: string): id is TranslatedRole => Object.hasOwn(LABELS, id);

/** The job's name, as its row and every sentence about it say it: translated while it reads as the translation's English. */
export const roleLabel = (role: Pick<ModelRoleSpec, `id` | `label`>): string =>
    translatedRole(role.id) && ENGLISH.get(role.id)?.label === role.label ? LABELS[role.id]() : role.label;

/** The line under the job's name. */
export const roleBlurb = (role: Pick<ModelRoleSpec, `id` | `blurb`>): string =>
    translatedRole(role.id) && ENGLISH.get(role.id)?.blurb === role.blurb ? BLURBS[role.id]() : role.blurb;


const PRESET_NAMES = {
    low: () => t(`sandbox.agentModels.presets.low`),
    medium: () => t(`sandbox.agentModels.presets.medium`),
    high: () => t(`sandbox.agentModels.presets.high`),
} as const satisfies Record<PresetSetup, () => string>;

/** A setup's name as the page says it: the owner's words if they gave any, a preset's own otherwise. */
export const setupName = (setup: { readonly preset: PresetSetup | undefined; readonly name: string | undefined }): string =>
    setup.name ?? (setup.preset === undefined ? `` : PRESET_NAMES[setup.preset]());
