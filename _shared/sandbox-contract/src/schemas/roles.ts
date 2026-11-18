// The named faces a sandbox shows the outside world: which accounts each speaks for, where it works, what it is told and
// what it runs on. What a conversation wearing one may reach is access, not the card (docs/architecture/access.md).
import { z } from "zod";
import { type ModelSource, readyChain } from "../models/model-pins.js";
import { type ModelPin, ModelPinSchema } from "./agent.js";
import { entryId } from "./internal.js";
import { SkillDraftSchema, SkillNameSchema, SYSTEM_PROMPT_MAX, SystemPromptModeSchema } from "./settings.js";
import { ceilingWords, ExtensionIdSchema, intersectCeilings, type ToolCeiling } from "./tool-ceiling.js";
// THE SHELVES A TURN HOLDS, fully resolved: no card carries them any more. A card's limits are an access profile that
// lists it (schemas/access-profiles.ts `roles`), held like every other limit in the principal chain, so a turn's shelves
// are the full toolbox under the ceiling of everything it acts for, its role's profile included (roles.ts
// `turnRole`, `capRole` in the daemon). Kept as one shape because every runtime reads a turn's shelves from it.
// Narrowing is enforced by absence (no credential injected) or by removing tools from context; `shell` decides, since
// with it a session can reach anything else fenced off, turning the rest into defaults, not limits.
export const RolePowersSchema = z.object({
    // "read" is look-and-search only; "write" adds creating and changing; "none" removes both.
    files: z
        .enum(["none", "read", "write"])
        .default("write")
        .describe("What it may do with files: nothing, look and search, or also create and change."),
    shell: z
        .boolean()
        .default(true)
        .describe(
            "Whether it may run commands, and with them the terminals, the test runs and every tool on the image. The switch the strength of the others depends on.",
        ),
    code: z
        .boolean()
        .default(true)
        .describe(
            "Whether it may write and run a script rather than a command line. Its fence is real where the shell's is not: reads and writes follow the files answer, and it can start no other program unless commands are allowed too. The one stated gap is that the fence cannot cut the network.",
        ),
    web: z.boolean().default(true).describe("Whether it may fetch a page or run a search."),
    // Credential-free; a signed-in browser is a `capabilities` account instead, safe to leave on.
    browser: z.boolean().default(true),
    // Spawn sub-agents and run workflows.
    delegate: z.boolean().default(true),
    // Sandbox settings, manifests, and the public outbox; enforced as a path refusal, not a tool switch — there's no
    // such tool to remove.
    sandbox: z.boolean().default(true),
    // By extension id (`publisher.name`, or a git install's card id): absent means every enabled one, empty means none.
    // Resolved from the access the turn runs under (tool-ceiling.ts `extensions`). Which connectors, devices and servers
    // it gets is decided by its credential reach, never by these shelves (secrets/credential-reach.ts in the daemon).
    extensions: z
        .array(ExtensionIdSchema)
        .max(100)
        .optional()
        .describe(
            "Which extensions' own agent tools and agent plugin (skills, commands, subagents) it gets, by extension id. Absent means every enabled one; empty means none. The tools an extension serves for a connected card follow that card's credential instead.",
        ),
});
export type RolePowers = z.infer<typeof RolePowersSchema>;
// Where a conversation wearing the card opens. Which folders it may touch is access: the areas of a profile that lists the
// card (2026-11-18: `folders` left the card for that, carried into a profile by roles/role-access-step.ts).
// No placement field, by decision: every session already opens in its own private copy, never the shared tree.
export const RoleWorkspaceSchema = z.object({
    // Absent means the workspace root.
    startIn: z.string().max(200).optional().describe("Which folder a conversation opens in."),
});
export type RoleWorkspace = z.infer<typeof RoleWorkspaceSchema>;
// Which nested repos a checkout holds, distinct from the areas its access fences file tools to. The
// root repo is always carried, never listed; absent means every repository. An object, not a list, for future sibling
// fields.
export const RoleContextSchema = z.object({
    repos: z
        .array(z.string().min(1).max(200))
        .max(50)
        .describe(
            "Which nested repositories a conversation on this role carries, by workspace-relative path. The workspace itself is always carried; empty means the workspace alone.",
        ),
});
export type RoleContext = z.infer<typeof RoleContextSchema>;
// What the sandbox puts in front of a user's message before the model reads it — the rows the chat shows under "Sent
// with your message" — and which of them a role card may drop. The vocabulary lives beside the card because the card
// editor has to name the same rows the transcript does, and two lists would drift into two vocabularies for one thing.
// Ids, not titles, are what a card stores: a title is display text and gets reworded, and a reworded title must not
// silently switch a note back on. The daemon maps each id to the titles it covers (agent/prompt/turn-briefing.ts).
// `search` named the iq teaching note, removed with iq (2026-11-18); it stays readable because a saved card may still
// list it, and covers no row now.
export const TurnBriefingNoteIdSchema = z.enum(["map", "context", "skills", "search", "delegation", "checks", "dependencies", "repoSync", "handoff"]);
export type TurnBriefingNoteId = z.infer<typeof TurnBriefingNoteIdSchema>;

export interface TurnBriefingNote {
    readonly id: TurnBriefingNoteId;
    // Verbatim the row's own title in the chat's "Sent with your message" fold, so a card turns off the line its reader
    // actually saw. A daemon-side test holds the two in step.
    readonly label: string;
    // When it rides at all. Most are once per conversation, and one whose condition never comes up costs nothing
    // whether it is switched on or off.
    readonly when: string;
    // What the turn loses without it, as the consequence rather than the feature — the only thing that makes this a
    // decision rather than a guess.
    readonly cost: string;
}

// Ordered as a turn meets them: where it is, what it holds, what it can reach, what happens at the end, then the two
// that report on state rather than teach.
export const TURN_BRIEFING_NOTES: readonly TurnBriefingNote[] = [
    {
        id: "map",
        label: "Map of this project",
        when: "First message of a conversation, when the sandbox's own map setting is on.",
        cost: "The agent finds the layout by listing directories instead, which costs tool calls on the first task.",
    },
    {
        id: "context",
        label: "Context of this session",
        when: "First message, and again after a compaction, for a card that carries only some repositories.",
        cost: "A repository this card leaves out of the checkout reads as deleted rather than absent, so the agent may try to restore it.",
    },
    {
        id: "skills",
        label: "Skills available in this workspace",
        when: "First message, on a runtime that cannot read the skills folder for itself.",
        cost: "On those runtimes the agent never learns its skills exist, so it will not load one.",
    },
    {
        id: "delegation",
        label: "Spawning subagents",
        when: "First message, on a shell-only runtime, for a card that may delegate.",
        cost: "The agent does the work itself rather than handing parts of it to other conversations.",
    },
    {
        id: "checks",
        label: "Checks after landing",
        when: "First message and after a compaction: that nothing checks its work when it finishes or after it lands, which checks are its to run, and that CI checks what the owner pushes.",
        cost: "The agent does not know what checks its work, so it may run the whole repository's suite on a shared machine, or chase a failure main already has.",
    },
    {
        id: "dependencies",
        label: "Dependencies aren't installed yet",
        when: 'Any turn where a project under the workspace has dependencies missing, or behind what it pins — the second reads "Dependencies are behind" and this covers both.',
        cost: "An unresolved import reads as broken code, and the agent may edit working source to satisfy it.",
    },
    {
        id: "repoSync",
        label: "Repos synced with their remotes",
        when: "A turn on the shared tree where a repository actually moved.",
        cost: "Files changed under the agent between turns with nothing saying so.",
    },
    {
        id: "handoff",
        label: "Where the work stands",
        when: "A turn that starts a fresh session on an existing conversation: a runtime change, or a context limit.",
        cost: "The largest of these. Without it a re-seeded session has the transcript but none of the sandbox's own readings of the tree, the proof and the checklist, so it re-derives them.",
    },
];

export interface TurnBriefingFixture {
    readonly label: string;
    // Why it cannot be switched off, in the one line the card editor shows beside it.
    readonly why: string;
}

// Deliberately not switchable, and listed so the checklist above reads as complete rather than arbitrary. Each of these
// either keeps a turn from writing outside its own branch or explains why something the agent expected is missing —
// saving a few hundred tokens is never worth either.
export const TURN_BRIEFING_FIXTURES: readonly TurnBriefingFixture[] = [
    { label: "Where this turn's files live", why: "Without it a runtime that is only cwd'd into its branch writes into the shared checkout." },
    { label: "Who this turn is acting as", why: "The card's own identity, on the runtimes that have nowhere else to put it." },
    // Kept under a card's own system prompt too (system-prompt.ts `ownPrompt`): writing a prompt withdraws this product's
    // guidance, never the owner's own rules.
    {
        label: "Standing instructions for this workspace",
        why: "Your own AGENTS.md rules, sent even when this card has its own system prompt. Change them in AGENTS.md.",
    },
    {
        label: "Some connected accounts need a person's approval",
        why: "Names who to ask; without it a withheld account reads as simply not connected.",
    },
    { label: "This turn reaches no signed-in account", why: "The other reason an account can be missing, which nothing else says out loud." },
    { label: "How to read this message", why: "Keeps a message that opens with a slash from being eaten by the runtime's own command parser." },
];
// What the sandbox tells a turn before the user's own words (the notes above). A deny list, not a pick list:
// an id absent from `omit` is sent, so a note added later rides every card that never said otherwise. An object, like
// `context`, for future sibling fields.
export const RoleBriefingSchema = z.object({
    omit: z
        .array(TurnBriefingNoteIdSchema)
        .max(20)
        .describe(
            "Which of the notes the sandbox prepends to each message a conversation on this role does NOT get. Everything not named here is sent as usual; the notes that keep a turn inside its own branch or explain a missing account cannot be named at all.",
        ),
});
export type RoleBriefing = z.infer<typeof RoleBriefingSchema>;
export const RoleSchema = z.object({
    id: entryId.describe("The role's id."),
    label: z.string().max(60).optional().describe("What to call it on screen. Absent falls back to the id, which somebody chose anyway."),
    capabilities: z
        .array(entryId)
        .max(50)
        .describe(
            "Which signed-in accounts it speaks through: who it is to the outside world, the one thing a card decides about reach. Named individually rather than by site, because two accounts on one site is the whole problem this solves. An account here is still reached only when whoever the turn acts for may use it. Naming one that is not connected yet is not an error: it is a card describing an account this sandbox has still to sign into.",
        ),
    // Owner-written, not derived: a classifier routes better on prose than on a list of account ids. Absent, the router
    // has less to go on but still tries.
    brief: z
        .string()
        .max(200)
        .optional()
        .describe(
            "What this role is for, in one line. A new chat is routed onto a role by this sentence, and the Roles page shows it under the name.",
        ),
    workspace: RoleWorkspaceSchema.optional().describe("Where a conversation wearing it opens. Absent means the workspace root."),
    context: RoleContextSchema.optional().describe(
        "Which part of the workspace a conversation wearing it carries: the repositories its checkout holds. Absent means every repository.",
    ),
    // Sits beside `context` on purpose: one says what the tree holds, the other what the turn is handed about it.
    briefing: RoleBriefingSchema.optional().describe(
        "Which of the notes the sandbox prepends to every message this card's conversations do without. Absent means all of them, which is what a card written before this existed keeps.",
    ),
    // Ladder shape (a single pin is a single point of failure); picking the card moves the composer's model pill to its
    // head, and it fills an unattended turn's silence before the run role's list.
    models: z
        .array(ModelPinSchema)
        .max(10)
        .optional()
        .describe(
            "Which models a conversation wearing it runs on, tried in order. Absent means whatever the chat or the job would have run on anyway; a model chosen for the turn itself always wins.",
        ),
    // Absent means follow the sandbox (the fourth answer, not a fifth enum value). The actual prompt text lives in
    // `PROMPT.md` in the card's kit folder, not here; "custom" with no file yet still falls back to the sandbox's own
    // prompt.
    systemPromptMode: SystemPromptModeSchema.optional(),
});
export type Role = z.infer<typeof RoleSchema>;
// Ladder filtered to connected providers, deduplicated. Empty (absent, or every provider disconnected) means the card
// has no opinion — the caller decides, not "run nothing".
export const roleModels = (card: Pick<Role, "models">, sources: readonly ModelSource[]): readonly ModelPin[] =>
    readyChain(sources, card.models ?? []);
// Which role a new chat belongs to is asked with what it runs on, in one reading: chat-route.ts.
// The one stock role id; lives here because the daemon and the automations form are separate packages that must
// agree on it exactly, or a Visitor chat pins to a card nobody creates.
export const VISITOR_CHAT_ROLE = "visitor-chat";
// THE TWO BUILT-IN ROLES, postures like any card: every turn wears one, and a turn naming no card wears one of these,
// picked by whether a person is watching (roles.ts `turnRole` in the daemon). They are constants rather than cards
// in roles.json: that file is tracked in git, and "every account" is not something a card's account list can say,
// since the list is written once and accounts are connected later. Neither can be edited or removed, and no card may
// take either id. Both stay inside what the turn's principals may (docs/architecture/access.md): "every account" is
// every account they may use.
// All accounts: every signed-in account, what a chat a person starts without picking anyone acts as. Its id predates
// the label (it was "Full access" until 2026-11-18, a name the Full access tier of a person's access also carries) and
// is stored on automations, sender rules and links, so it stays.
export const FULL_ACCESS_ROLE = "full-access";
// No accounts: no signed-in account, what a run nobody watches acts as when it names no one, since
// whatever woke it may have put somebody else's words in its prompt.
export const NO_ACCOUNTS_ROLE = "no-accounts";
export type BuiltInRoleId = typeof FULL_ACCESS_ROLE | typeof NO_ACCOUNTS_ROLE;
export interface BuiltInRole {
    readonly id: BuiltInRoleId;
    // English, for the daemon's own words (a turn's standing, its notes); every screen says it through its own catalog.
    readonly label: string;
    // Whether its turns reach the sandbox's signed-in accounts: all of them, or none.
    readonly accounts: "all" | "none";
}
const FULL_ACCESS: BuiltInRole = { id: FULL_ACCESS_ROLE, label: "All accounts", accounts: "all" };
const NO_ACCOUNTS: BuiltInRole = { id: NO_ACCOUNTS_ROLE, label: "No accounts", accounts: "none" };
export const BUILT_IN_ROLES: readonly BuiltInRole[] = [FULL_ACCESS, NO_ACCOUNTS];
export const isBuiltInRole = (id: string | undefined): id is BuiltInRoleId => id === FULL_ACCESS_ROLE || id === NO_ACCOUNTS_ROLE;
export const builtInRole = (id: BuiltInRoleId): BuiltInRole => (id === FULL_ACCESS_ROLE ? FULL_ACCESS : NO_ACCOUNTS);
// Who a turn naming no card acts as: All accounts with a person watching, No accounts without.
export const defaultRole = (unattended: boolean): BuiltInRoleId => (unattended ? NO_ACCOUNTS_ROLE : FULL_ACCESS_ROLE);
// An unwatched run's role pick with No accounts read as no pick: an unwatched turn naming none wears No accounts
// anyway, so the two are one choice, and a form shows them as one row.
export const unwatchedPick = (actsAs: string | undefined): string | undefined => (actsAs === NO_ACCOUNTS_ROLE ? undefined : actsAs);
// One phrase describing how bounded a card is, from the access profiles that list it (schemas/access-profiles.ts
// `roles`), shared so the Roles page and the automation picker can't grow different vocabularies for the same card.
// "Read-only"/"no shell" are named; everything else collapses to a count.
export const roleBounds = (held: readonly { readonly tools?: ToolCeiling | undefined; readonly areas?: readonly string[] | undefined; readonly credentials?: unknown }[]): string => {
    const ceiling = held.reduce<ToolCeiling | undefined>((at, profile) => intersectCeilings(at, profile.tools), undefined);
    if (ceiling?.files === "read" && ceiling.shell === false) {
        return "Read-only";
    }
    if (ceiling?.shell === false) {
        return "No shell";
    }
    const limits = ceilingWords(ceiling).length + (held.some((profile) => profile.areas !== undefined) ? 1 : 0) + (held.some((profile) => profile.credentials !== undefined) ? 1 : 0);
    return limits === 0 ? "Full powers" : `${limits} limit${limits === 1 ? "" : "s"}`;
};
export const RoleIdParamSchema = z.object({ id: entryId.describe("Which role.") });
// `connected` is what makes a freshly cloned workspace honest: every role shows even though most can't act yet. An
// id with no capability at all is `connected: false` too.
export const RolesListSchema = z.object({
    roles: z.array(RoleSchema).describe("The characters an agent can wear."),
    connected: z
        .array(z.string())
        .describe(
            "Which accounts are actually connected right now, so a role naming one that has since been disconnected can be shown as broken rather than as working.",
        ),
});
// One route for the kit's prompt and skills, one folder and one screen. Skills come back as name/description only; an
// empty prompt means no PROMPT.md yet, sent as "" since the field is a textarea.
export const RoleKitSchema = z.object({
    prompt: z
        .string()
        .describe("What this role is told, on top of everything else. Empty means it simply follows the sandbox's own instructions."),
    skills: z
        .array(
            z.object({
                name: z.string().describe("The skill's name."),
                description: z.string().describe("What it is for."),
            }),
        )
        .describe(
            "Skills only this role's conversations can reach. A different question from what the agent knows generally, with a different answer.",
        ),
});
export type RoleKit = z.infer<typeof RoleKitSchema>;
export const RolePromptSchema = RoleIdParamSchema.extend({
    prompt: z
        .string()
        .max(SYSTEM_PROMPT_MAX)
        .describe(
            "What to tell this role. Sending an empty one removes it entirely rather than storing a blank, so the role falls back to the sandbox's own instructions.",
        ),
});
export const RoleSkillSchema = RoleIdParamSchema.extend(SkillDraftSchema.shape);
export const RoleSkillNameSchema = RoleIdParamSchema.extend({ name: SkillNameSchema.describe("Which skill.") });
// Same listing/body split the sandbox's own skills make, for editing.
export const RoleSkillBodySchema = z.object({
    name: z.string().describe("The skill's name."),
    description: z.string().describe("What it is for."),
    body: z.string().describe("The skill itself, in full."),
});
