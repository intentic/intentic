import { z } from "zod";

/* EVERY JOB IN THIS SANDBOX THAT PICKS A MODEL, LISTED BY THE JOB IT IS, one row per answer the owner is
 * entitled to give differently.
 *
 * WHAT THIS REPLACED, and why it had to go. Model settings used to be grouped by how HARD the work was assumed
 * to be: a "quick model" for the small automatic jobs, an "agent runs" tier for the big ones. Both names
 * described an intensity rather than a job, and an intensity is a guess somebody else made about work the owner
 * knows better. A commit message written by a frontier model is not a mistake, it is a preference, and the
 * grouping made it unsayable: pinning Opus to get better commit subjects also pinned it to session titles, to
 * every loop verdict, and to the safety judge. One bundled row could not say the thing anyone actually wanted
 * to say.
 *
 * SO THE UNIT IS THE ROLE. Each entry here is one place a model gets chosen, and each gets its own ordered list
 * in settings.modelRoles. Seventeen rows is more than four, and that is the point rather than a cost being
 * absorbed: the configuration and the UI both already existed per use-case, and collapsing them was the only
 * thing standing between the owner and a choice the machinery could already honour. A simpler face over this
 * (presets: "cheap everywhere", "frontier everywhere") is a thing that can be built ON TOP of a true model, and
 * cannot be unpicked from a lossy one.
 *
 * EVERY LIST IS AN ORDERED LADDER, whatever the role, and for one reason: the interesting failure of a pinned
 * model is not that it is wrong, it is that it is CONNECTED AND WILL NOT ANSWER TODAY. The account's allowance
 * went on the chat this morning, and one spent provider takes the role down for hours while three others sit
 * idle. Written in order, the next entry catches it.
 *
 * AN EMPTY LIST IS THE JOB SWITCHED OFF, and NOTHING IS DERIVED FOR IT. A helper role used to fall to an
 * "Auto ladder" worked out from whatever was connected — every provider's cheapest row, best-first — so a
 * sandbox that had never been configured still spent somebody's account on commit messages and safety
 * verdicts, on a recommendation this table invented, which re-ranked itself the day another account was
 * connected. Not set now means not set: no auto-selection, no recommendation, and the owner names the models
 * for a job or the job does not happen.
 *
 * TWO KINDS, and what separates them is what the CALLER does with that empty answer. It is declared per role
 * because it is a property of the job:
 *
 *   helper — a one-shot. One prompt, no tools, one string back, and it is over. With no list the job does not
 *            run at all: no commit subject is drafted, no session is renamed, no command is judged. Every one
 *            of them already had a road for "the model could not answer" (the derived title stands, the
 *            commit box stays empty, the gate falls to its standing rule), so an owner who wants none of them
 *            leaves the row empty and pays nothing.
 *
 *   run    — a whole session with tools and a worktree, started by a surface rather than by a person at a
 *            composer. With no list the caller's own floor answers: the model the owner picked for their chat.
 *            That is not this table recommending anything — it is a choice they already made, in front of
 *            them, on the composer they work in.
 *
 * EVERY ENTRY IS A FULL PIN (ModelPinSchema): which model, and how it runs — effort, thinking, speed, harness.
 * The helper roles carry them too, which they did not use to: a one-shot ran with reasoning forcibly off, so
 * pinning a reasoning model to commit messages bought the price of one and the behaviour of neither. The knobs
 * now ride through the one-shot path (the daemon's role-model.ts), so an entry means what it says wherever it
 * is written.
 *
 * ADDING A ROLE IS ONE ROW HERE. The settings key, the resolver's floor, the daemon's lookup and the settings
 * page's row all read this table, so a job that starts picking a model tomorrow becomes configurable by saying
 * what it is. That is the property the old grouping cost: a new surface inherited "agent runs" by being
 * unattended, which is how a documentation sweep and a production incident came to share one tier. */

export const ModelRoleKindSchema = z.enum(["helper", "run"]);
export type ModelRoleKind = z.infer<typeof ModelRoleKindSchema>;

/* WHAT STARTS A RUN, declared for the run roles alone.
 *
 * It is not a wire value and never has been: it decides which BLOCK a job is read in, and the argument for
 * reading them apart is the same one that separates a helper from a run — an owner holds a session nobody is
 * watching to a different budget from one they are sitting in front of. The settings page used to make that
 * argument in a comment over a thirteen-row list ("the ones somebody presses ahead of the ones that fire on
 * their own"), which is a claim no reader can check and no row has to honour. Declared, it draws the page.
 *
 * A HELPER DECLARES NONE, and that is the honest answer rather than a gap: nobody presses "write me a commit
 * subject". It happens because something else did. */
export type ModelRoleTrigger = "pressed" | "unprompted";

/* The shape of a row. `id` is a bare string HERE and narrowed on the exported type below, because the id union
 * is derived from this very table: a self-referential `satisfies` would be a type that has to know its own
 * answer before it can check it. */
interface ModelRoleRow {
    readonly id: string;
    // What the settings row is called. A JOB, in the owner's words, never a tier.
    readonly label: string;
    // The row's one line: what this model is asked to do. Read beside the label, so it says what the label
    // cannot rather than restating it.
    readonly blurb: string;
    readonly kind: ModelRoleKind;
    /** Runs only, and required for every one of them: see `ModelRoleTrigger`. */
    readonly trigger?: ModelRoleTrigger;
    // The row's glyph, from the shared icon set. Here rather than in a web-side map because the whole value of
    // this table is that a role is declared ONCE; a second table keyed by the same ids is the drift this
    // replaced, moved one layer up.
    readonly icon: string;
}

/* THE TABLE. Ordered as the settings page draws it, and the order is an argument about reach: the one-shots
 * first, because nobody chose a model for them and they run constantly; then the runs somebody's click starts;
 * then the runs that start themselves, which are the ones an owner is least likely to be watching and most
 * likely to want held to a budget. Those three are BLOCKS now (see MODEL_ROLE_BLOCKS) rather than an ordering
 * this comment asserts and nothing holds to.
 *
 * The ids are the wire vocabulary: a turn carries one (AgentTurn.runRole), so they are kebab-case and stable,
 * and renaming one is a breaking change to the setting rather than a cosmetic edit. */
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
        /* THE ONE HELPER WHOSE INPUT IS ADVERSARIAL, and the reason the old bundling was worst here. Its prompt
         * contains a command the agent is about to run, which may have arrived from a stranger's web page, and a
         * small model can be talked round by it. Being wrong is expensive in both directions: a needless card
         * teaches the owner to click through the next one. */
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
        /* THE ONE HELPER THAT ANSWERS A CLASSIFICATION rather than writing prose: one card id, or none, from the
         * owner's own short list (schemas/personas.ts `brief`). Cheap by construction, once per chat, and the
         * job a small model does well, which is the whole argument for routing chats onto static cards rather
         * than asking a model to compose a context per session. */
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
        /* PRESSED, ON THE STRENGTH OF THE APPROVAL. Nothing here runs until somebody reads the item and says
         * yes, and that press is the start of this turn as much as Fix is the start of a pipeline run — the
         * queue between the two is machinery, not a second decision. */
        id: "approval-queue",
        label: "Approvals queue",
        blurb: "The turn that publishes or acts on what you approved.",
        kind: "run",
        trigger: "pressed",
        icon: "check-circle",
    },
    {
        id: "automation-wake",
        label: "Automation wakes",
        blurb: "A turn an automation fires: a schedule, a webhook, a message from outside.",
        kind: "run",
        trigger: "unprompted",
        icon: "clock",
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
    {
        id: "watch-wake",
        label: "Watch wakes",
        blurb: "The turn a watch starts when the thing it was watching happens.",
        kind: "run",
        trigger: "unprompted",
        icon: "eye",
    },
    {
        id: "verify-nudge",
        label: "Verify nudges",
        blurb: "The follow-up turn sent when work was left unverified.",
        kind: "run",
        trigger: "unprompted",
        icon: "search",
    },
    {
        /* THE ONE ROLE THAT ANSWERS A CHOICE RATHER THAN FILLING A SILENCE. A spawning agent may name its
         * child's provider, and when it does that wins, exactly as a caret pick wins on every other run role.
         * This is what answers when it names none, which used to be a hardcoded "claude". */
        id: "child-agent",
        label: "Child agents",
        blurb: "What an agent's own subagents run on when it names no model for them.",
        kind: "run",
        trigger: "unprompted",
        icon: "users",
    },
] as const satisfies readonly ModelRoleRow[];

export type ModelRole = (typeof MODEL_ROLES)[number]["id"];
export type ModelRoleSpec = ModelRoleRow & { readonly id: ModelRole };

export const MODEL_ROLE_IDS = MODEL_ROLES.map((role) => role.id) as readonly ModelRole[];

/* The wire form. An enum rather than a string, unlike most ids in this contract, because there is no case for
 * an unknown one: a role is a place in THIS codebase where a model gets chosen, so a value outside the table
 * names nothing, and a settings file or a turn carrying one is a typo worth a clean error rather than a list
 * silently ignored. */
export const ModelRoleSchema = z.enum(MODEL_ROLE_IDS as [ModelRole, ...ModelRole[]]);

/* ═══ THE BLOCKS THE SETTINGS PAGE READS IN ═══
 *
 * EIGHTEEN JOBS IN ONE LIST IS A TABLE, NOT A PAGE. The unit being the role is right and is not in question —
 * it is what lets an owner pin Opus to commit subjects without pinning it to every session title — but the cost
 * lands on whoever opens the page: one unbroken run of eighteen rows, each with a name, a sentence, a control
 * and a list under it, with no landmark to say where you are in it or which rows are like the one you came for.
 *
 * SO THE BLOCKS ARE DECLARED, AND THEY ARE THE DISTINCTIONS THE TABLE ALREADY MAKES. Nothing here is a fresh
 * taxonomy invented for the layout: `kind` was always the difference between a one-shot and a whole session,
 * and `trigger` is the sentence the old table wrote in a comment about its own ordering. A block is what those
 * two answers already separate, given a name and a heading.
 *
 * THE LABELS LIVE HERE, beside the role labels, for the same reason those do: a heading kept in a web-side map
 * keyed by the same ids is the drift a single table exists to stop. What is NOT here is anything about how the
 * page draws them — that is the page's, and it changes on its own schedule.
 *
 * ORDER IS REACH, and it is the order of the table itself: jobs nobody picked a model for, then sessions a
 * click of yours starts, then sessions that start without one. Every role belongs to exactly one block and
 * every block keeps the table's order, which is what makes a role added upstairs appear on the page by
 * existing. */
export type ModelRoleBlockId = "helper" | "pressed" | "unprompted";

export interface ModelRoleBlock {
    readonly id: ModelRoleBlockId;
    /** The group's heading on the settings page. */
    readonly label: string;
    /** One line beside it: what the jobs in this block have in common that the others do not. */
    readonly caption: string;
    /** Its roles, in table order. */
    readonly roles: readonly ModelRoleSpec[];
}

const rolesWhere = (match: (role: ModelRoleSpec) => boolean): readonly ModelRoleSpec[] => MODEL_ROLES.filter((role) => match(role));

export const MODEL_ROLE_BLOCKS: readonly ModelRoleBlock[] = [
    {
        id: "helper",
        label: "Automatic helpers",
        caption: "One prompt, no tools, one answer back.",
        roles: rolesWhere((role) => role.kind === "helper"),
    },
    {
        id: "pressed",
        label: "Runs you start",
        caption: "Whole sessions, begun by a click of yours.",
        roles: rolesWhere((role) => role.kind === "run" && role.trigger === "pressed"),
    },
    {
        id: "unprompted",
        label: "Runs that start themselves",
        caption: "Whole sessions nobody pressed for.",
        roles: rolesWhere((role) => role.kind === "run" && role.trigger === "unprompted"),
    },
];
