import { z } from "zod";

// Every job that picks a model, one row per job; the unit is the role, not a difficulty tier. Each list is an ordered
// fallback ladder; empty means the job is off (helper) or falls back to the caller's own chat model (run). Adding a
// role is one row here, settings, resolver and daemon all read this table.

export const ModelRoleKindSchema = z.enum(["helper", "run"]);
export type ModelRoleKind = z.infer<typeof ModelRoleKindSchema>;

// Which block a run role sorts into on the settings page: pressed by the owner, or started unprompted; helpers declare
// none.
export type ModelRoleTrigger = "pressed" | "unprompted";

// `id` is a bare string here; narrowed to the role union on `ModelRoleSpec` below, since that union derives from this
// table via `satisfies`.
interface ModelRoleRow {
    readonly id: string;
    // The owner's own words for the job; never a difficulty tier.
    readonly label: string;
    // Must add information beyond the label, not restate it.
    readonly blurb: string;
    readonly kind: ModelRoleKind;
    /** Required when `kind` is "run"; unset for helpers. */
    readonly trigger?: ModelRoleTrigger;
    // Icon name from the shared icon set; kept here, not in a separate web-side map keyed by id.
    readonly icon: string;
}

// Ids are wire-stable (`AgentTurn.runRole`); order matches the settings page's block grouping below.
export const MODEL_ROLES = [
    {
        id: "commit-message",
        label: "Commit messages",
        blurb: "The subject written when an agent's work lands, and the release note under it.",
        kind: "helper",
        icon: "file-edit",
    },
    {
        id: "session-title",
        label: "Session titles",
        blurb: "The name a conversation wears on the board, written a second into its first turn.",
        kind: "helper",
        icon: "pencil",
    },
    {
        // Prompt includes the command about to run, which may be attacker-controlled; a small model can be swayed.
        id: "safety-judge",
        label: "Safety judge",
        blurb: "Which model reads your safety policy before a flagged command runs.",
        kind: "helper",
        icon: "shield",
    },
    {
        id: "loop-verdict",
        label: "Loop verdicts",
        blurb: "Whether a loop's iteration met the goal, or the loop goes round again.",
        kind: "helper",
        icon: "check-square",
    },
    {
        // Picks one persona id or none from a fixed list; a classification, not free text.
        id: "persona-router",
        label: "Persona routing",
        blurb: "Which model reads a new chat's first message and picks the persona for it.",
        kind: "helper",
        icon: "users",
    },
    {
        id: "pipeline-fix",
        label: "Pipeline fixes",
        blurb: "The agent started by Fix on a red pipeline.",
        kind: "run",
        trigger: "pressed",
        icon: "wave-pulse",
    },
    {
        id: "deployment-fix",
        label: "Deployment fixes",
        blurb: "The agent started by Fix on a deployment that is down.",
        kind: "run",
        trigger: "pressed",
        icon: "server",
    },
    {
        id: "maintenance-chore",
        label: "Maintenance chores",
        blurb: "A chore run started from the Maintenance board.",
        kind: "run",
        trigger: "pressed",
        icon: "wrench",
    },
    {
        id: "documentation-run",
        label: "Documentation runs",
        blurb: "A pass over a repo's own documentation.",
        kind: "run",
        trigger: "pressed",
        icon: "book",
    },
    {
        id: "acceptance-run",
        label: "Acceptance runs",
        blurb: "One session per story in an acceptance fan-out.",
        kind: "run",
        trigger: "pressed",
        icon: "list-check",
    },
    {
        id: "pre-push-fix",
        label: "Pre-push fixes",
        blurb: "The fix proposed when a check fails on the way to a push.",
        kind: "run",
        trigger: "pressed",
        icon: "cloud-upload",
    },
    {
        // Pressed trigger: the owner's approval click starts this turn; the queue between is just machinery.
        id: "approval-queue",
        label: "Approvals queue",
        blurb: "The turn that publishes or acts on what you approved.",
        kind: "run",
        trigger: "pressed",
        icon: "check-circle",
    },
    {
        id: "extension-review",
        label: "Extension update reviews",
        blurb: "The agent that reads an extension update before it is applied.",
        kind: "run",
        trigger: "unprompted",
        icon: "box",
    },
    {
        id: "loop-iteration",
        label: "Loop iterations",
        blurb: "Each round of a loop working towards its goal.",
        kind: "run",
        trigger: "unprompted",
        icon: "repeat",
    },
] as const satisfies readonly ModelRoleRow[];

export type ModelRole = (typeof MODEL_ROLES)[number]["id"];
export type ModelRoleSpec = ModelRoleRow & { readonly id: ModelRole };

export const MODEL_ROLE_IDS = MODEL_ROLES.map((role) => role.id) as readonly ModelRole[];

// Enum, not a string: an id outside this table names nothing, so it should fail loudly rather than be ignored.
export const ModelRoleSchema = z.enum(MODEL_ROLE_IDS as [ModelRole, ...ModelRole[]]);

// Groups MODEL_ROLES for the settings page by kind and trigger; each role belongs to exactly one block, in table order.
export type ModelRoleBlockId = "helper" | "pressed" | "unprompted";

export interface ModelRoleBlock {
    readonly id: ModelRoleBlockId;
    /** Heading shown on the settings page. */
    readonly label: string;
    /** Its roles, in MODEL_ROLES order. */
    readonly roles: readonly ModelRoleSpec[];
}

const rolesWhere = (match: (role: ModelRoleSpec) => boolean): readonly ModelRoleSpec[] => MODEL_ROLES.filter((role) => match(role));

export const MODEL_ROLE_BLOCKS: readonly ModelRoleBlock[] = [
    {
        id: "helper",
        label: "Automatic helpers",
        roles: rolesWhere((role) => role.kind === "helper"),
    },
    {
        id: "pressed",
        label: "Runs you start",
        roles: rolesWhere((role) => role.kind === "run" && role.trigger === "pressed"),
    },
    {
        id: "unprompted",
        label: "Runs that start themselves",
        roles: rolesWhere((role) => role.kind === "run" && role.trigger === "unprompted"),
    },
];
