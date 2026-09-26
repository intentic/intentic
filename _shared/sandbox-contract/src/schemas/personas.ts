// The named faces a sandbox shows the outside world: which accounts each speaks for, what a session wearing one may do,
// and where it works.
import { z } from "zod";
import { type ModelSource, readyChain } from "../models/model-pins.js";
import { type ModelPin, ModelPinSchema } from "./agent.js";
import { entryId } from "./internal.js";
import { SkillDraftSchema, SkillNameSchema, SystemPromptModeSchema } from "./settings.js";
// A named face the sandbox shows outward: who it speaks as, what it may do, where it works, what it's told, what it
// runs on. No credential lives on the card; accounts stay private, per-sandbox. Not a security boundary for a watched
// chat — a real fence only for an unattended turn, whose resolver defaults to nothing.
// Enforced by absence (`connectors`/`devices`/`mcp`: no credential injected) or by removing tools from context; `shell`
// decides, since with it a session can reach anything else fenced off, turning the rest into defaults, not limits.
// Absent `powers` means the full toolbox.
export const PersonaPowersSchema = z.object({
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
    // By id; absent means every one of them (an untouched card's default), empty means none — a tri-state that is why
    // these are optional arrays, not defaulted ones.
    connectors: z.array(entryId).max(100).optional(),
    devices: z.array(entryId).max(50).optional(),
    mcp: z.array(entryId).max(50).optional(),
    // By extension id (`publisher.name`, or a git install's card id), the same tri-state. A card an extension serves
    // rides `connectors`; this is what the extension brings of its own.
    extensions: z
        .array(
            z
                .string()
                .min(1)
                .max(121)
                .regex(/^[a-zA-Z0-9][a-zA-Z0-9_.-]*$/),
        )
        .max(100)
        .optional()
        .describe(
            "Which extensions' own agent tools and agent plugin (skills, commands, subagents) it gets, by extension id. Absent means every enabled one; empty means none. The tools an extension serves for a connected card follow the connectors list instead.",
        ),
});
export type PersonaPowers = z.infer<typeof PersonaPowersSchema>;
// `folders` only refuses file-tool calls outside it; it stops a misread instruction, not a shell. The container is the
// real workspace-wide fence, and a conversation started by a fenced person is narrower still — the turn works inside
// this persona's folders AND that person's areas, never the wider of the two.
// A plain folder list rather than a named area (schemas/areas.ts), because the two answer different questions: a
// persona's fence is written once for that persona, while an area is a grant several people hold and one edit has to
// move all of them.
// No placement field, by decision: every session already opens in its own private copy, never the shared tree.
export const PersonaWorkspaceSchema = z.object({
    // Absent means the workspace root.
    startIn: z.string().max(200).optional().describe("Which folder a conversation opens in."),
    folders: z.array(z.string().min(1)).max(50).optional().describe("Which folders it may touch at all. Absent means the whole workspace."),
});
export type PersonaWorkspace = z.infer<typeof PersonaWorkspaceSchema>;
// Which nested repos a checkout holds, distinct from `workspace.folders` (what file tools may touch inside it). The
// root repo is always carried, never listed; absent means every repository. An object, not a list, for future sibling
// fields.
export const PersonaContextSchema = z.object({
    repos: z
        .array(z.string().min(1).max(200))
        .max(50)
        .describe(
            "Which nested repositories a conversation on this persona carries, by workspace-relative path. The workspace itself is always carried; empty means the workspace alone.",
        ),
});
export type PersonaContext = z.infer<typeof PersonaContextSchema>;
// What the sandbox puts in front of a user's message before the model reads it — the rows the chat shows under "Sent
// with your message" — and which of them a persona card may drop. The vocabulary lives beside the card because the card
// editor has to name the same rows the transcript does, and two lists would drift into two vocabularies for one thing.
// Ids, not titles, are what a card stores: a title is display text and gets reworded, and a reworded title must not
// silently switch a note back on. The daemon maps each id to the titles it covers (agent/prompt/turn-briefing.ts).
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
        id: "search",
        label: "Using iq for workspace search",
        when: "First message, when the workspace search setting is on and the runtime has no plugin seam.",
        cost: "The agent falls back to grep-style searching, which it can already do.",
    },
    {
        id: "delegation",
        label: "Spawning child agents",
        when: "First message, on a shell-only runtime, for a card that may delegate.",
        cost: "The agent does the work itself rather than handing parts of it to other conversations.",
    },
    {
        id: "checks",
        label: "Checks after landing",
        when: "First message and after a compaction, and again whenever the main tree's own check turns red or back to green: what runs after its work lands, and which failures the main tree already has.",
        cost: "The agent does not know which failures are the main tree's own and not its doing, so it may spend a turn chasing one somebody else is already fixing.",
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
    { label: "Standing instructions for this workspace", why: "Your own AGENTS.md rules. Replace them by giving this card its own system prompt." },
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
export const PersonaBriefingSchema = z.object({
    omit: z
        .array(TurnBriefingNoteIdSchema)
        .max(20)
        .describe(
            "Which of the notes the sandbox prepends to each message a conversation on this persona does NOT get. Everything not named here is sent as usual; the notes that keep a turn inside its own branch or explain a missing account cannot be named at all.",
        ),
});
export type PersonaBriefing = z.infer<typeof PersonaBriefingSchema>;
export const PersonaSchema = z.object({
    id: entryId.describe("The persona's id."),
    label: z.string().max(60).optional().describe("What to call it on screen. Absent falls back to the id, which somebody chose anyway."),
    capabilities: z
        .array(entryId)
        .max(50)
        .describe(
            "Which connected accounts are its hands. Named individually rather than by site, because two accounts on one site is the whole problem this solves. Naming one that is not connected yet is not an error: it is a card describing an account this sandbox has still to sign into.",
        ),
    // Owner-written, not derived: a classifier routes better on prose than on a list of account ids. Absent, the router
    // has less to go on but still tries.
    brief: z
        .string()
        .max(200)
        .optional()
        .describe(
            "What this persona is for, in one line. A new chat is routed onto a persona by this sentence, and the Personas page shows it under the name.",
        ),
    powers: PersonaPowersSchema.optional().describe(
        "What a conversation wearing it may do. Absent means the full toolbox, so a card written before this existed behaves exactly as it did.",
    ),
    workspace: PersonaWorkspaceSchema.optional().describe("Where it works. Absent means the whole workspace."),
    context: PersonaContextSchema.optional().describe(
        "Which part of the workspace a conversation wearing it carries: the repositories its checkout holds. Absent means every repository.",
    ),
    // Sits beside `context` on purpose: one says what the tree holds, the other what the turn is handed about it.
    briefing: PersonaBriefingSchema.optional().describe(
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
export type Persona = z.infer<typeof PersonaSchema>;
// Ladder filtered to connected providers, deduplicated. Empty (absent, or every provider disconnected) means the card
// has no opinion — the caller decides, not "run nothing".
export const personaModels = (card: Pick<Persona, "models">, sources: readonly ModelSource[]): readonly ModelPin[] =>
    readyChain(sources, card.models ?? []);
// Which persona a new chat belongs to is asked with what it runs on, in one reading: chat-route.ts.
// The one stock persona id; lives here because the daemon and the automations form are separate packages that must
// agree on it exactly, or a Visitor chat pins to a card nobody creates.
export const VISITOR_CHAT_PERSONA = "visitor-chat";
// One phrase describing how bounded a card is, shared so the Personas page and the automation picker can't grow
// different vocabularies for the same card. "Read-only"/"no shell" are named; everything else collapses to a count.
export const personaBounds = (persona: Persona): string => {
    const powers = persona.powers;
    if (powers === undefined) {
        return "Full powers";
    }
    const resolved = PersonaPowersSchema.parse(powers);
    if (resolved.files === "read" && !resolved.shell) {
        return "Read-only";
    }
    if (!resolved.shell) {
        return "No shell";
    }
    const limits = [
        resolved.files === "none",
        !resolved.code,
        !resolved.web,
        !resolved.browser,
        !resolved.delegate,
        !resolved.sandbox,
        resolved.connectors !== undefined,
        resolved.devices !== undefined,
        resolved.mcp !== undefined,
    ].filter(Boolean).length;
    return limits === 0 ? "Full powers" : `${limits} limit${limits === 1 ? "" : "s"}`;
};
export const PersonaIdParamSchema = z.object({ id: entryId.describe("Which persona.") });
// `connected` is what makes a freshly cloned workspace honest: every persona shows even though most can't act yet. An
// id with no capability at all is `connected: false` too.
export const PersonasListSchema = z.object({
    personas: z.array(PersonaSchema).describe("The characters an agent can wear."),
    connected: z
        .array(z.string())
        .describe(
            "Which accounts are actually connected right now, so a persona naming one that has since been disconnected can be shown as broken rather than as working.",
        ),
});
// One route for the kit's prompt and skills, one folder and one screen. Skills come back as name/description only; an
// empty prompt means no PROMPT.md yet, sent as "" since the field is a textarea.
export const PersonaKitSchema = z.object({
    prompt: z
        .string()
        .describe("What this persona is told, on top of everything else. Empty means it simply follows the sandbox's own instructions."),
    skills: z
        .array(
            z.object({
                name: z.string().describe("The skill's name."),
                description: z.string().describe("What it is for."),
            }),
        )
        .describe(
            "Skills only this persona's conversations can reach. A different question from what the agent knows generally, with a different answer.",
        ),
});
export type PersonaKit = z.infer<typeof PersonaKitSchema>;
export const PersonaPromptSchema = PersonaIdParamSchema.extend({
    prompt: z
        .string()
        .max(20000)
        .describe(
            "What to tell this persona. Sending an empty one removes it entirely rather than storing a blank, so the persona falls back to the sandbox's own instructions.",
        ),
});
export const PersonaSkillSchema = PersonaIdParamSchema.extend(SkillDraftSchema.shape);
export const PersonaSkillNameSchema = PersonaIdParamSchema.extend({ name: SkillNameSchema.describe("Which skill.") });
// Same listing/body split the sandbox's own skills make, for editing.
export const PersonaSkillBodySchema = z.object({
    name: z.string().describe("The skill's name."),
    description: z.string().describe("What it is for."),
    body: z.string().describe("The skill itself, in full."),
});
