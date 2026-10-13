import { z } from "zod";

// Every job that picks a model, one row per job; the unit is the role, not a difficulty tier. A job runs on the setup it
// was put on (model-setups.ts), an ordered fallback ladder it shares with every other job put there; a job on none, or
// on an empty one, is off (helper) or falls back to the caller's own chat model (run). Adding a role is one row here, settings, resolver
// and daemon all read this table.

export const ModelRoleKindSchema = z.enum(["helper", "run"]);
export type ModelRoleKind = z.infer<typeof ModelRoleKindSchema>;

// The three setups every sandbox has, cheapest first: worked out from what is connected until the owner edits one
// (model-setups.ts `presetPins`). Ids are stored, so they are wire-stable.
export const PRESET_SETUPS = ["low", "medium", "high"] as const;
export type PresetSetup = (typeof PRESET_SETUPS)[number];

// `id` is a bare string here; narrowed to the role union on `ModelRoleSpec` below, since that union derives from this
// table via `satisfies`.
interface ModelRoleRow {
    readonly id: string;
    // The owner's own words for the job; never a difficulty tier.
    readonly label: string;
    // Must add information beyond the label, not restate it.
    readonly blurb: string;
    readonly kind: ModelRoleKind;
    // Icon name from the shared icon set; kept here, not in a separate web-side map keyed by id.
    readonly icon: string;
    // The preset suggested for this job, offered when it is placed: what the work needs, not what it costs today. Only
    // a suggestion: a job runs on nothing until someone puts it on a setup.
    readonly setup: PresetSetup;
}

// Ids are wire-stable (`AgentTurn.runRole`); order is the settings page's: one-shot helpers first, then whole sessions.
export const MODEL_ROLES = [
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
        // effort and an account, and a persona id, each a classification over a fixed list rather than free text. The
        // id predates the persona half and stays as it is, since it is what a settings file already carries.
        // Prompt carries live account headroom, so it must not be a model whose own allowance it is reading.
        id: "model-router",
        label: "New chat routing",
        blurb: "Which model reads a new chat's first message and picks what it opens on: the model, effort and account, and the persona.",
        kind: "helper",
        icon: "sparkles",
        setup: "low",
    },
    {
        id: "pipeline-fix",
        label: "Pipeline fixes",
        blurb: "The agent started by Fix on a failed pipeline.",
        kind: "run",
        icon: "wave-pulse",
        setup: "high",
    },
    {
        id: "deployment-fix",
        label: "Deployment fixes",
        blurb: "The agent started by Fix on a deployment that is down.",
        kind: "run",
        icon: "server",
        setup: "high",
    },
    {
        id: "maintenance-chore",
        label: "Maintenance chores",
        blurb: "A chore run started from the Maintenance board.",
        kind: "run",
        icon: "wrench",
        setup: "medium",
    },
    {
        id: "refactor-run",
        label: "Refactors",
        blurb: "The agent started from a hotspot or key module on a repository's Health tab.",
        kind: "run",
        icon: "hammer",
        setup: "high",
    },
    {
        id: "documentation-run",
        label: "Documentation runs",
        blurb: "A pass over a repo's own documentation.",
        kind: "run",
        icon: "book",
        setup: "medium",
    },
    {
        id: "acceptance-run",
        label: "Acceptance runs",
        blurb: "One session per story in an acceptance fan-out.",
        kind: "run",
        icon: "list-check",
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
        id: "linked-task",
        label: "Linked sandbox tasks",
        blurb: "A task another of your sandboxes handed to this one over a link.",
        kind: "run",
        icon: "link",
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
] as const satisfies readonly ModelRoleRow[];

export type ModelRole = (typeof MODEL_ROLES)[number]["id"];
export type ModelRoleSpec = ModelRoleRow & { readonly id: ModelRole };

export const MODEL_ROLE_IDS = MODEL_ROLES.map((role) => role.id) as readonly ModelRole[];

// Enum, not a string: an id outside this table names nothing, so it should fail loudly rather than be ignored.
export const ModelRoleSchema = z.enum(MODEL_ROLE_IDS as [ModelRole, ...ModelRole[]]);
