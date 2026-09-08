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
});
export type PersonaPowers = z.infer<typeof PersonaPowersSchema>;
// `folders` only refuses file-tool calls outside it; it stops a misread instruction, not a shell. The container is the
// real workspace-wide fence.
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
            "Which nested repositories a conversation wearing this card carries, by workspace-relative path. The workspace itself is always carried; empty means the workspace alone.",
        ),
});
export type PersonaContext = z.infer<typeof PersonaContextSchema>;
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
        .describe("What this persona is for, in one line. A new chat is routed onto a persona by this sentence, and the Personas page shows it under the name."),
    powers: PersonaPowersSchema.optional().describe(
        "What a conversation wearing it may do. Absent means the full toolbox, so a card written before this existed behaves exactly as it did.",
    ),
    workspace: PersonaWorkspaceSchema.optional().describe("Where it works. Absent means the whole workspace."),
    context: PersonaContextSchema.optional().describe(
        "Which part of the workspace a conversation wearing it carries: the repositories its checkout holds. Absent means every repository.",
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
export const personaModels = (card: Pick<Persona, "models">, sources: readonly ModelSource[]): readonly ModelPin[] => readyChain(sources, card.models ?? []);
// Asked once per chat, on the message it was sent with; answers with the one card the message belongs to, or none.
// `folder`/`paths` are the facts a card's `context`/`startIn` can be matched against that words alone can't supply.
export const PersonaRouteAskSchema = z.object({
    prompt: z.string().min(1).max(20000).describe("The message a new chat is about to open with."),
    folder: z.string().max(200).optional().describe("The workspace folder the chat was opened in, when it was opened in one."),
    paths: z.array(z.string().min(1).max(500)).max(50).default([]).describe("Workspace paths the message names: uploads, @-mentions, the editor's own file."),
});
export type PersonaRouteAsk = z.infer<typeof PersonaRouteAskSchema>;
export const PersonaRouteSchema = z.object({
    persona: entryId.optional().describe("The card this message belongs to, or absent when none does and the chat should stay open to everything."),
    reason: z.string().describe("Why, in the one line a chat can show. Present whether or not a card was named."),
    // Absent means nothing was spent: matched on the folder, or answered before any model was reached.
    model: z
        .string()
        .optional()
        .describe(
            "Which model answered, as `provider:model`, so the chat can name what the reading cost. Absent when no model was asked at all, which a folder match and an empty persona list both are.",
        ),
});
export type PersonaRoute = z.infer<typeof PersonaRouteSchema>;
// The one stock persona id; lives here because the daemon and the automations form are separate packages that must
// agree on it exactly, or a Front Desk pins to a card nobody creates.
export const FRONT_DESK_PERSONA = "front-desk";
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
