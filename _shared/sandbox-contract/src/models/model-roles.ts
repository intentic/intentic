import { MODEL_ROLE_ID, MODEL_ROLE_ID_MAX, type ModelRoleContribution } from "@intentic/extension-manifest";
import { z } from "zod";

// Every job that picks a model, one row per job; the unit is the role, not a difficulty tier. A job runs on the setup it
// was put on (model-setups.ts), an ordered fallback ladder it shares with every other job put there; a job on none, or
// on an empty one, is off (helper) or falls back to the caller's own chat model (run). This table holds the sandbox's
// own jobs; an extension declares the jobs it starts runs for (`contributes.modelRoles`), and the daemon serves both
// (`GET /settings/model-roles`), which the settings page and every reader that resolves a job by id read.
// (2026-11-26) Until then this table also listed six extensions' jobs, so a job could not come and go with its extension.

export const ModelRoleKindSchema = z.enum(["helper", "run"]);
export type ModelRoleKind = z.infer<typeof ModelRoleKindSchema>;

// The three setups every sandbox has, cheapest first: worked out from what is connected until the owner edits one
// (model-setups.ts `presetPins`). Ids are stored, so they are wire-stable.
export const PRESET_SETUPS = ["low", "medium", "high"] as const;
export type PresetSetup = (typeof PRESET_SETUPS)[number];

// One job, the sandbox's own or an extension's. `id` is a bare string: an extension's job is named by its declaration.
export interface ModelRoleSpec {
    readonly id: string;
    // The owner's own words for the job; never a difficulty tier.
    readonly label: string;
    // Must add information beyond the label, not restate it.
    readonly blurb: string;
    readonly kind: ModelRoleKind;
    // Icon name from the shared icon set; kept here, not in a separate web-side map keyed by id.
    readonly icon: string;
    // The default preset for this job in a fresh sandbox, also offered when placing it again:
    // what the work needs, not what it costs today.
    readonly setup: PresetSetup;
}

// Ids are wire-stable (`AgentTurn.job`, `runRole`); order is the settings page's: one-shot helpers first, then whole sessions,
// then the enabled extensions' jobs.
export const CORE_MODEL_ROLES = [
    {
        id: "commit-message",
        label: "Commit messages",
        blurb: "The subject written when an agent's work lands, and the release note under it.",
        kind: "helper",
        icon: "file-edit",
        setup: "low",
    },
    {
        id: "session-title",
        label: "Session titles",
        blurb: "The name a conversation wears on the board, written a second into its first turn.",
        kind: "helper",
        icon: "pencil",
        setup: "low",
    },
    {
        // Prompt includes the command about to run, which may be attacker-controlled; a small model can be swayed.
        id: "safety-judge",
        label: "Safety judge",
        blurb: "Which model reads your safety policy before a flagged command runs.",
        kind: "helper",
        icon: "shield",
        setup: "medium",
    },
    {
        id: "loop-verdict",
        label: "Loop verdicts",
        blurb: "Whether a loop's iteration met the goal, or the loop goes round again.",
        kind: "helper",
        icon: "check-square",
        setup: "medium",
    },
    {
        // Reads a whole conversation (capped tool output) once, so a small model with a large window suits it best.
        id: "handoff-summary",
        label: "Hand-off summaries",
        blurb: "The summary a fresh session opens with when you choose to summarise a long conversation that hit a usage limit, instead of re-reading it all.",
        kind: "helper",
        icon: "align-left",
        setup: "low",
    },
    {
        // Reads one finished reply (and the ask it answered) and writes what a person hears in hands-free voice: a few
        // short sentences, never markdown. A fast model matters more than a strong one, since the person is waiting.
        id: "spoken-reply",
        label: "Spoken replies",
        blurb: "The few sentences you hear when you talk to the agent hands-free: what it did and what it needs from you, while the full reply stays on screen.",
        kind: "helper",
        icon: "volume-up",
        setup: "low",
    },
    {
        // One reading answering both halves of "what does this chat open on": an offered `provider:model` line with an
        // effort and an account, and a role id, each a classification over a fixed list rather than free text. The
        // id predates the role half and stays as it is, since it is what a settings file already carries.
        // Prompt carries live account headroom, so it must not be a model whose own allowance it is reading.
        id: "model-router",
        label: "New chat routing",
        blurb: "Which model reads a new chat's first message and picks what it opens on: the model, effort and account, and the role.",
        kind: "helper",
        icon: "sparkles",
        setup: "low",
    },
    {
        // Asked only when a spawned subagent nobody placed could take one of a runner's last free slots while this
        // sandbox still has room for light work (runners/child-placement.ts roomContested); never on a quiet fleet.
        id: "subagent-sizing",
        label: "Subagent sizing",
        blurb: "Whether a subagent's task reads as heavy (builds, tests) or light, when a runner's last free slots should go to the heavier work.",
        kind: "helper",
        icon: "server",
        setup: "low",
    },
    {
        // Started by a person's press on a failure the app cannot settle by itself (agentFix.ts in the editor): a sync that
        // conflicts, a push the remote refuses, a commit a hook refuses, a dev server that crashed, a build that failed.
        id: "workflow-fix",
        label: "Workflow fixes",
        blurb: "The agent started by Fix with agent on a failed sync, push, commit, run or build.",
        kind: "run",
        icon: "wrench",
        setup: "high",
    },
    {
        id: "approval-queue",
        label: "Approvals queue",
        blurb: "The turn that publishes or acts on what you approved.",
        kind: "run",
        icon: "check-circle",
        setup: "medium",
    },
    {
        id: "extension-review",
        label: "Extension update reviews",
        blurb: "The agent that reads an extension update before it is applied.",
        kind: "run",
        icon: "box",
        setup: "medium",
    },
    {
        id: "loop-iteration",
        label: "Loop iterations",
        blurb: "Each round of a loop working towards its goal.",
        kind: "run",
        icon: "repeat",
        setup: "high",
    },
] as const satisfies readonly ModelRoleSpec[];

// One of the sandbox's own jobs.
export type CoreModelRole = (typeof CORE_MODEL_ROLES)[number]["id"];
// Any job's id, the sandbox's own or one an extension declares: what `AgentTurn.job` and the keys of `roleSetups` hold.
export type ModelRole = string;

const CORE_IDS = new Set<string>(CORE_MODEL_ROLES.map((role) => role.id));
export const isCoreModelRole = (id: string): id is CoreModelRole => CORE_IDS.has(id);

/** One of the sandbox's own jobs by id, or undefined for an extension's (or nobody's). */
export const coreModelRole = (id: string): ModelRoleSpec | undefined => CORE_MODEL_ROLES.find((role) => role.id === id);

// A string, not the table's enum (2026-11-26): an extension's job is named by its declaration, which the contract cannot
// list. A run naming a job nobody declares opens on the caller's own model, as a run naming none does.
export const ModelRoleSchema = z
    .string()
    .max(MODEL_ROLE_ID_MAX)
    .regex(MODEL_ROLE_ID, "a job's id is lowercase words joined by dashes")
    .describe("A job's id: one of the sandbox's own (`commit-message`, `loop-iteration`) or one an enabled extension declares (`pipeline-fix`).");

// One job as the daemon serves it to the settings page (`GET /settings/model-roles`): the sandbox's own and every
// installed extension's, an extension's switched off kept in the list so a page placing jobs keeps its stored choice.
export const ModelRoleEntrySchema = z.object({
    id: ModelRoleSchema,
    label: z.string().min(1).describe("What the settings page calls the job."),
    blurb: z.string().min(1).describe("One sentence on what starts it, beyond the label."),
    kind: ModelRoleKindSchema.describe("`helper`: a one-shot call the sandbox makes. `run`: a whole session."),
    icon: z.string().min(1).describe("A name from the host's icon set."),
    setup: z.enum(PRESET_SETUPS).describe("The preset it runs on until it is placed, and where it goes when placed again."),
    extension: z.string().min(1).optional().describe("The extension that declares it (`publisher.name`); absent on the sandbox's own jobs."),
    enabled: z.boolean().describe("False while the extension that declares it is switched off: its job is not shown, and the owner's choice for it is kept."),
});
export type ModelRoleEntry = z.infer<typeof ModelRoleEntrySchema>;

export const ModelRolesSchema = z.object({
    roles: z.array(ModelRoleEntrySchema).describe("The sandbox's own jobs, then each installed extension's, in the settings page's order."),
});
export type ModelRoles = z.infer<typeof ModelRolesSchema>;

/** A job an extension declares, as it is served: always a whole session, suggested `medium` unless it says otherwise. */
export const contributedModelRole = (declared: ModelRoleContribution, extension: string, enabled: boolean): ModelRoleEntry => ({
    id: declared.id,
    label: declared.label,
    blurb: declared.explanation,
    kind: "run",
    icon: declared.icon ?? "wrench",
    setup: declared.setup ?? "medium",
    extension,
    enabled,
});

/** The sandbox's own jobs as served. */
export const coreModelRoleEntries = (): ModelRoleEntry[] => CORE_MODEL_ROLES.map((role) => ({ ...role, enabled: true }));

// (2026-11-26) The six jobs this table held for extensions until they declared them in their manifests
// (`contributes.modelRoles`), as the table had them, by the extension that now declares each. Frozen, and read only where
// the past is: a daemon older than extension API 2.52.0 serves no job list and knows these as its own, so the settings
// page shows them from here (docs/architecture/app-plane.md, older daemons); and the 2026-10-12 settings conversion
// placed jobs in the table's order of that day (settings-history.ts). `refactor-run` belongs to nobody: nothing has
// started it since the Health tab went (2026-11-18), and it stays only so a stored choice naming it still reads.
export const EXTENSION_ROLES_BEFORE_CONTRIBUTIONS = [
    {
        id: "pipeline-fix",
        label: "Pipeline fixes",
        blurb: "The agent started by Fix on a failed pipeline.",
        kind: "run",
        icon: "wave-pulse",
        setup: "high",
        extension: "intentic.pipelines",
    },
    {
        id: "deployment-fix",
        label: "Deployment fixes",
        blurb: "The agent started by Fix on a deployment that is down.",
        kind: "run",
        icon: "server",
        setup: "high",
        extension: "intentic.deployments",
    },
    {
        id: "maintenance-chore",
        label: "Maintenance chores",
        blurb: "A chore run started from the Maintenance board.",
        kind: "run",
        icon: "wrench",
        setup: "medium",
        extension: "intentic.maintenance",
    },
    {
        id: "refactor-run",
        label: "Refactors",
        blurb: "Kept so settings saved before the Health tab was removed still read; nothing starts a refactor run now.",
        kind: "run",
        icon: "hammer",
        setup: "high",
        extension: undefined,
    },
    {
        id: "documentation-run",
        label: "Documentation runs",
        blurb: "A pass over a repo's own documentation.",
        kind: "run",
        icon: "book",
        setup: "medium",
        extension: "intentic.documentation",
    },
    {
        id: "acceptance-run",
        label: "Acceptance runs",
        blurb: "One session per story in an acceptance fan-out.",
        kind: "run",
        icon: "list-check",
        setup: "high",
        extension: "intentic.acceptance",
    },
] as const satisfies readonly (ModelRoleSpec & { readonly extension: string | undefined })[];

// The order the table held every job in until 2026-11-26, the six above among the sandbox's own.
const ORDER_BEFORE_CONTRIBUTIONS = [
    "commit-message",
    "session-title",
    "safety-judge",
    "loop-verdict",
    "handoff-summary",
    "spoken-reply",
    "model-router",
    "subagent-sizing",
    "pipeline-fix",
    "deployment-fix",
    "workflow-fix",
    "maintenance-chore",
    "refactor-run",
    "documentation-run",
    "acceptance-run",
    "approval-queue",
    "extension-review",
    "loop-iteration",
] as const;

// The ids `AgentTurn.runRole` takes: every job the table held until 2026-11-26, frozen. A schema a door's far end reads in
// the field may only grow (_tools/checks/lib/release-doors.mjs), so this enum stays as it was beside the open `job` that
// names an extension's job; every daemon reads `runRole`, and one from before ignores `job`.
export const RunRoleSchema = z.enum(ORDER_BEFORE_CONTRIBUTIONS);
export type RunRole = z.infer<typeof RunRoleSchema>;

/** How a turn names its job: `runRole` for one every daemon knows, `job` for one only a newer daemon does. */
export const jobFields = (role: ModelRole): { readonly runRole: RunRole } | { readonly job: ModelRole } => {
    const known = RunRoleSchema.safeParse(role);
    return known.success ? { runRole: known.data } : { job: role };
};

/** Every job the table held until 2026-11-26, in its order then: what a daemon from before served, and what the 2026-10-12 conversion placed. */
export const ROLES_BEFORE_CONTRIBUTIONS: readonly ModelRoleSpec[] = ORDER_BEFORE_CONTRIBUTIONS.map((id) => {
    const spec = coreModelRole(id) ?? EXTENSION_ROLES_BEFORE_CONTRIBUTIONS.find((role) => role.id === id);
    if (spec === undefined) {
        throw new Error(`model-roles: "${id}" is in neither table`);
    }
    return spec;
});
