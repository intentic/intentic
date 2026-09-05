// Personas: the named faces a sandbox shows the outside world — which accounts each speaks for, what a
// session wearing one may do, and where it works.
import { z } from "zod";
import { entryId } from "./internal.js";
import { SkillDraftSchema, SkillNameSchema, SystemPromptModeSchema } from "./settings.js";
/* A NAMED PERSONA THE SANDBOX SHOWS THE OUTSIDE WORLD, "work-reddit", "the studio account", and the layer
 * that decides which connected accounts a given turn may act through.
 *
 * IT ANSWERS FOUR QUESTIONS AND NO MORE: who it speaks as, what it may do, where it works, and what it is told.
 * Making one is then a name, a few accounts, some switches and, only if you want one, a prompt. That is the
 * whole of what an owner is deciding, and short enough that they finish.
 *
 *   NO PUBLISH-OR-DRAFT SWITCH. It read as a lock and was a sentence: it asked the turn to route outward things
 *   through the approvals queue and could not stop it posting. The queue is the mechanism, and a control whose
 *   label promises more than it delivers is worse than no control, it is the one an owner trusts.
 *
 *   THE FOURTH QUESTION IS THE SYSTEM PROMPT, NOT A TONE NOTE, and the difference is why the field that used to
 *   sit here was removed and this one is not it. What was removed was a paragraph on how a persona WRITES:
 *   optional, answered by almost nobody, and shaping nothing a person could see afterwards. `systemPromptMode`
 *   is the same setting the sandbox has, asked per card, it replaces the whole prompt, and with the kit folder
 *   beside it (persona-kit.ts) a card can carry its own skills and tools too. That is a persona being a working
 *   posture rather than a label, and it shows: a release-notes writer and a code reviewer are two prompts, not
 *   two adjectives.
 *
 * THE CARD AND THE KEYS ARE DELIBERATELY SEPARATE. This is the card: a name, the accounts it speaks for, what a
 * session wearing it may do, where it works. It carries NO credential, which is what lets it be the one thing under
 * .intentic that is committed and reviewed like the workspace's instructions are (see personas-store.ts for
 * the exclude carve-out that makes that true). The keys, the logged-in browser profile, its cookies, its
 * passkey, stay where they already are: private to the sandbox, never exported without an explicit opt-in. So a
 * cloned workspace arrives listing its personas, each visibly unconnected, waiting for one sign-in apiece.
 *
 * WHAT IT IS NOT is a security boundary. A chat still reaches every connected account by default (that is the
 * owner's chosen posture, a chat has a human in the room), and an agent with a shell can reach a token whatever
 * this file says. What it prevents is the mistake this codebase already names as the one that cannot be undone:
 * a post from the wrong account. Where nobody is watching, an unattended wake, it is a real fence, because
 * there the resolver's default is NOTHING rather than everything (see turnPersona in personas.ts). */
/* WHAT A PERSONA MAY DO, the shelves, one switch each, and the half of the card that bounds the turn rather
 * than the account it speaks for.
 *
 * SHELVES, NOT TOOL NAMES. Every field here is a phrase a person decides about ("run commands", "read the
 * web"), never the name of a tool. Tool names drift with every runtime upgrade, one power answers to several of
 * them, and a connector is not a tool at all, it is a shell command plus a credential. Naming the shelf means
 * a tool added next month lands inside an answer the owner already gave, and a card written today still means
 * what it said after the SDK renames something.
 *
 * TWO STRENGTHS, AND THE DIFFERENCE IS VISIBLE FROM HERE. Everything capability-shaped (`connectors`,
 * `devices`, `mcp`, and the accounts in `capabilities`) is enforced by ABSENCE, the credential is never
 * injected, the server never mounted, the browser never launched, which is the same mechanism the account
 * filter already uses and needs no cooperation from the model. The plain switches are enforced by taking the
 * tools out of the turn's context, which holds for every tool the harness owns and cannot reach a program the
 * agent runs for itself.
 *
 * WHICH IS WHY `shell` IS THE ONE THAT DECIDES. A session with a shell can read a credential this card never
 * granted it, so switching it off is what turns the rest of these into a fence; leaving it on leaves them a
 * strong default. The card's own UI says so at the switch, see PersonaForm.vue, because a limit that is
 * weaker than it looks is worse than no limit at all.
 *
 * PERMISSIVE BY DEFAULT, deliberately, and the opposite of the account rule directly below it. An unrepeatable
 * public post is worth defaulting to nothing for; an over-powered turn inside a container the owner can throw
 * away is not, and it is the same reasoning that makes bypassPermissions this sandbox's default posture. So an
 * absent `powers` means today's full toolbox, and a workspace that never opens this notices nothing. */
export const PersonaPowersSchema = z.object({
    // "read" is look-and-search only; "write" adds creating and changing; "none" takes both away.
    files: z
        .enum(["none", "read", "write"])
        .default("write")
        .describe("What it may do with files: nothing, look and search, or also create and change."),
    // Shell commands, and with them the terminals, the test runs, and every CLI on the image. See the header:
    // this is the switch the others' strength depends on.
    shell: z
        .boolean()
        .default(true)
        .describe(
            "Whether it may run commands, and with them the terminals, the test runs and every tool on the image. The switch the strength of the others depends on.",
        ),
    /* The JS execution backend (AgentCapabilities.execution): the model writes a script instead of a command
     * line, run in a permission-fenced Node subprocess. Its fence is REAL where the shell's is not, reads and
     * writes follow the `files` answer, and it can start no other program unless `shell` is also on, with one
     * stated gap: the fence cannot cut the network, so a script can fetch whatever `web` says. */
    code: z
        .boolean()
        .default(true)
        .describe(
            "Whether it may write and run a script rather than a command line. Its fence is real where the shell's is not: reads and writes follow the files answer, and it can start no other program unless commands are allowed too. The one stated gap is that the fence cannot cut the network.",
        ),
    // Fetch a page, run a search.
    web: z.boolean().default(true).describe("Whether it may fetch a page or run a search."),
    // The credential-free browser. The SIGNED-IN browsers are `capabilities` below, a different question, and
    // the reason this one is safe to leave on: it holds nobody's account.
    browser: z.boolean().default(true),
    // Spawn sub-agents and run workflows.
    delegate: z.boolean().default(true),
    /* Change the sandbox itself: its settings and manifests, and the public outbox that publishes a file to
     * anyone with the link. Enforced as a refusal on the paths that carry those, not as a tool switch, there
     * is no "install a capability" tool to take away, only files that mean it. */
    sandbox: z.boolean().default(true),
    /* The connected accounts and services this persona may reach, BY ID. Absent means every one of them, which
     * is what a card that has never thought about it should get; an empty list means none. That tri-state is the
     * whole reason these are optional rather than defaulted arrays, "all" and "none" are both real answers and
     * an empty default could only spell one of them. */
    connectors: z.array(entryId).max(100).optional(),
    devices: z.array(entryId).max(50).optional(),
    mcp: z.array(entryId).max(50).optional(),
});
export type PersonaPowers = z.infer<typeof PersonaPowersSchema>;
/* WHERE A PERSONA WORKS, the third question after who it is and what it may do.
 *
 * `folders` is the one field here that promises less than it looks like it promises, and the card says so where
 * it is set: it is enforced by refusing file tool calls that point outside, which stops a misread instruction
 * and an honest mistake, and does not stop a shell. The workspace-wide fence is the container. */
/* WHERE A SESSION WEARING THIS CARD WORKS, the folder it opens in, and the folders its file tools may touch.
 *
 * There is no placement field, and that is a decision rather than an omission. A card used to be able to ask
 * for the SHARED tree instead of its own copy; every surface already defaults to a private worktree
 * (conversation.ts), so the setting existed only to opt out of the isolation that makes parallel work safe,
 * expressed in three words ("whatever started it", "its own copy", "the shared workspace") that a reader had no
 * way to choose between. A persona starts where it is told and works in its own copy. */
export const PersonaWorkspaceSchema = z.object({
    // The repo (or folder) under the workspace a session starts in. Absent ⇒ the workspace root, as today.
    startIn: z.string().max(200).optional().describe("Which folder a conversation opens in."),
    // Workspace-relative folders the file tools may touch. Absent ⇒ anywhere under the workspace.
    folders: z.array(z.string().min(1)).max(50).optional().describe("Which folders it may touch at all. Absent means the whole workspace."),
});
export type PersonaWorkspace = z.infer<typeof PersonaWorkspaceSchema>;
export const PersonaSchema = z.object({
    id: entryId.describe("The persona's id."),
    // What the owner calls it in the composer chip. Absent ⇒ surfaces read the id, which is already human-chosen.
    label: z.string().max(60).optional().describe("What to call it on screen. Absent falls back to the id, which somebody chose anyway."),
    /* The capability ids this persona acts THROUGH, the logged-in browser accounts (and, later, the credential
     * connectors) that are its hands. Ids rather than platforms, because "two accounts of one site" is the whole
     * problem: `reddit-work` and `reddit-personal` are two capabilities and exactly one of them belongs here.
     *
     * An id naming a capability that isn't connected is not an error, it is a card describing an account this
     * sandbox has yet to sign into, which is precisely what a freshly cloned workspace looks like. */
    capabilities: z
        .array(entryId)
        .max(50)
        .describe(
            "Which connected accounts are its hands. Named individually rather than by site, because two accounts on one site is the whole problem this solves. Naming one that is not connected yet is not an error: it is a card describing an account this sandbox has still to sign into.",
        ),
    /* Which workspace repos prefer this persona, so a chat opened on a project starts with the right chip already
     * selected. A PREFERENCE, not a fence, the owner's chosen chat default is still "every account", and it
     * lives on the card rather than in each project's own config so that one account named by three repos stays
     * one definition instead of three that drift. */
    repos: z
        .array(z.string().min(1))
        .max(50)
        .optional()
        .describe(
            "Which repositories prefer this persona, so a conversation opened on one starts with the right choice already made. A preference rather than a fence.",
        ),
    // What a session wearing this card may do, and where it works. Both absent ⇒ the full toolbox and the whole
    // workspace, so a card written before these existed keeps behaving exactly as it did.
    powers: PersonaPowersSchema.optional().describe(
        "What a conversation wearing it may do. Absent means the full toolbox, so a card written before this existed behaves exactly as it did.",
    ),
    workspace: PersonaWorkspaceSchema.optional().describe("Where it works. Absent means the whole workspace."),
    /* WHICH SYSTEM PROMPT A SESSION WEARING THIS CARD RUNS ON, the same three bases the sandbox chooses
     * between, asked per card. ABSENT is the fourth answer and the default: follow the sandbox, which is what
     * every card meant before this field existed and what almost every card will go on meaning.
     *
     * Absent rather than a fifth enum value spelling the same thing. "inherit" and "not set" would be two
     * spellings of one answer, and the surface that offers four options maps its first to leaving this off.
     *
     * THE TEXT IS NOT HERE. Under "custom" it is `PROMPT.md` in the card's own kit folder
     * (personas/persona-kit.ts), for two reasons that point the same way: a system prompt is prose, and prose
     * belongs in a file where it diffs line by line rather than as one escaped string inside a record nobody
     * writes by hand, and the kit is already where that persona's skills and tools live, so there is one folder
     * to look in rather than a field here and a directory there.
     *
     * "custom" with no PROMPT.md written yet falls back to the sandbox's answer rather than running the turn on
     * an empty prompt: the card is half-made, and a half-made card should behave like the one it was before
     * somebody started editing it. */
    systemPromptMode: SystemPromptModeSchema.optional(),
});
export type Persona = z.infer<typeof PersonaSchema>;
/* THE ONE CARD ID THE PRODUCT NAMES ITSELF, the read-only persona a public web chat answers through.
 *
 * Nothing else is stock: a fresh workspace has no personas at all, and every card on the Personas page is one
 * the owner wrote. This id is the exception because a Front Desk is driven by a stranger with nobody watching, so
 * it is the one wake whose bounds cannot be left to the prompt's wording, the daemon writes the card the moment
 * a Front Desk is saved (personas/front-desk.ts) and the automations form fills a blank Front Desk persona with it.
 *
 * It lives HERE because those two are in different packages and must agree exactly. A literal in each would
 * drift into a Front Desk pinned to a card nobody creates, and turnPersona answers a missing card by denying
 * everything, a public chat that cannot even read, which is safe and useless.
 *
 * It is FRONT DESK and not "visitor": the card is who answers the people who arrive, not the person arriving. */
export const FRONT_DESK_PERSONA = "front-desk";
/* HOW BOUNDED A CARD IS, in one phrase, for the row badge on the Personas page and for the sentence under the
 * automations composer's persona picker.
 *
 * It lives in the contract rather than in either surface because those two are in different packages and would
 * otherwise each grow their own vocabulary for the same card: a workspace where the Personas page says
 * "Read-only" and the automation under it says "3 limits" is one where the reader cannot tell whether they are
 * looking at the same thing.
 *
 * TWO NAMED SHAPES AND THEN A COUNT. "Read-only" and "no shell" are the two people actually reach for, so they
 * get words; everything else gets a number, because listing four switched-off shelves in a badge produces a line
 * nobody reads and buries the one fact that matters, that this card is limited at all. */
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
/* Every persona, plus which of the accounts they name this sandbox is actually signed into. The second half is
 * what makes the list honest on a freshly cloned workspace: every card is present and most of them cannot act
 * yet, and a surface that showed only the cards would present a persona that is one login away from working as
 * though it already did. Ids the manifest has no capability for at all are `connected: false` too, a card may
 * name an account nobody has added here. */
export const PersonasListSchema = z.object({
    personas: z.array(PersonaSchema).describe("The characters an agent can wear."),
    connected: z
        .array(z.string())
        .describe(
            "Which accounts are actually connected right now, so a persona naming one that has since been disconnected can be shown as broken rather than as working.",
        ),
});
/* A PERSONA'S KIT, as one read, the prompt it runs on and the skills it carries.
 *
 * ONE ROUTE FOR BOTH because they are one folder and one screen: the card's editor draws them together, and two
 * requests to render one section is two chances for it to arrive half-drawn. The skills come back as name and
 * description only, for the same reason the sandbox's own skill list does, a body runs to thousands of words
 * and a group of one-line rows should not cost a hundred kilobytes to draw.
 *
 * An empty prompt is a card with no PROMPT.md, which is every card until somebody writes one. It is "" rather
 * than absent because the field behind it is a textarea, and a textarea's empty value is "". */
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
// One kit skill's instructions, for editing it, the same split the sandbox's own skills make between a listing
// and a body, and for the same reason.
export const PersonaSkillBodySchema = z.object({
    name: z.string().describe("The skill's name."),
    description: z.string().describe("What it is for."),
    body: z.string().describe("The skill itself, in full."),
});
