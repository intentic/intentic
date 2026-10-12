import type { ModelRole, ModelRoleSpec, PresetSetup } from "@intentic/sandbox-contract";
import { t } from "@intentic/ui/i18n";

// MODEL_ROLES names each job in English, for the daemon and the settings file as much as for the
// screen. These are the settings page's words for them, keyed by the wire-stable id; roleWords.test.ts holds the
// English copy equal to the contract's, so a renamed job cannot go on being shown under its old translation.

const LABELS: Readonly<Record<ModelRole, () => string>> = {
    "commit-message": () => t(`sandbox.modelRoles.commitMessage.label`),
    "session-title": () => t(`sandbox.modelRoles.sessionTitle.label`),
    "handoff-summary": () => t(`sandbox.modelRoles.handoffSummary.label`),
    "safety-judge": () => t(`sandbox.modelRoles.safetyJudge.label`),
    "loop-verdict": () => t(`sandbox.modelRoles.loopVerdict.label`),
    "model-router": () => t(`sandbox.modelRoles.modelRouter.label`),
    "pipeline-fix": () => t(`sandbox.modelRoles.pipelineFix.label`),
    "deployment-fix": () => t(`sandbox.modelRoles.deploymentFix.label`),
    "maintenance-chore": () => t(`sandbox.modelRoles.maintenanceChore.label`),
    "refactor-run": () => t(`sandbox.modelRoles.refactorRun.label`),
    "documentation-run": () => t(`sandbox.modelRoles.documentationRun.label`),
    "acceptance-run": () => t(`sandbox.modelRoles.acceptanceRun.label`),
    "approval-queue": () => t(`sandbox.modelRoles.approvalQueue.label`),
    "extension-review": () => t(`sandbox.modelRoles.extensionReview.label`),
    "loop-iteration": () => t(`sandbox.modelRoles.loopIteration.label`),
};

const BLURBS: Readonly<Record<ModelRole, () => string>> = {
    "commit-message": () => t(`sandbox.modelRoles.commitMessage.blurb`),
    "session-title": () => t(`sandbox.modelRoles.sessionTitle.blurb`),
    "handoff-summary": () => t(`sandbox.modelRoles.handoffSummary.blurb`),
    "safety-judge": () => t(`sandbox.modelRoles.safetyJudge.blurb`),
    "loop-verdict": () => t(`sandbox.modelRoles.loopVerdict.blurb`),
    "model-router": () => t(`sandbox.modelRoles.modelRouter.blurb`),
    "pipeline-fix": () => t(`sandbox.modelRoles.pipelineFix.blurb`),
    "deployment-fix": () => t(`sandbox.modelRoles.deploymentFix.blurb`),
    "maintenance-chore": () => t(`sandbox.modelRoles.maintenanceChore.blurb`),
    "refactor-run": () => t(`sandbox.modelRoles.refactorRun.blurb`),
    "documentation-run": () => t(`sandbox.modelRoles.documentationRun.blurb`),
    "acceptance-run": () => t(`sandbox.modelRoles.acceptanceRun.blurb`),
    "approval-queue": () => t(`sandbox.modelRoles.approvalQueue.blurb`),
    "extension-review": () => t(`sandbox.modelRoles.extensionReview.blurb`),
    "loop-iteration": () => t(`sandbox.modelRoles.loopIteration.blurb`),
};

/** The job's name, as its row and every sentence about it say it. */
export const roleLabel = (role: Pick<ModelRoleSpec, `id`>): string => LABELS[role.id]();

/** The line under the job's name. */
export const roleBlurb = (role: Pick<ModelRoleSpec, `id`>): string => BLURBS[role.id]();


const PRESET_NAMES = {
    low: () => t(`sandbox.agentModels.presets.low`),
    medium: () => t(`sandbox.agentModels.presets.medium`),
    high: () => t(`sandbox.agentModels.presets.high`),
} as const satisfies Record<PresetSetup, () => string>;

/** A setup's name as the page says it: the owner's words if they gave any, a preset's own otherwise. */
export const setupName = (setup: { readonly preset: PresetSetup | undefined; readonly name: string | undefined }): string =>
    setup.name ?? (setup.preset === undefined ? `` : PRESET_NAMES[setup.preset]());
