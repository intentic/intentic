import {
    type Capability,
    type Persona,
    type PersonaPowers,
    type PersonaWorkspace,
    type SystemPromptMode,
    FRONT_DESK_PERSONA,
    PersonaPowersSchema,
} from "@intentic/sandbox-contract";
import { FRONT_DESK_GUIDANCE } from "./front-desk.js";

/* WHO A TURN IS AND WHAT IT MAY DO — the whole persona layer in one function, so the rule lives in a single
 * place instead of being re-derived at each surface that needs it.
 *
 * The card answers four questions and this answers them together, because they are one decision at the moment
 * a session starts: which connected accounts it may act through, which shelves of its toolbox are open, where
 * in the workspace it works, and which system prompt it runs on (personaPrompt, at the foot of this file — the
 * text itself lives in the card's kit folder, persona-kit.ts).
 *
 * THE ACCOUNT RULE IS ASYMMETRIC ON PURPOSE, and the asymmetry is the design rather than an inconsistency:
 *
 *   A CHAT WITH NO PERSONA KEEPS EVERY ACCOUNT. A person is sitting at the composer. They can see what the
 *   agent is about to do and stop it, and making them pick a persona before a throwaway "check our mentions"
 *   would tax every ordinary turn to prevent a mistake a human is already positioned to catch.
 *
 *   AN UNATTENDED WAKE WITH NO PERSONA GETS NOTHING. Nobody is watching, the prompt may have been shaped by a
 *   stranger (a Front Desk), and the failure mode is a public post from the wrong account that cannot be taken
 *   back. Here the prompt's wording is the only thing left standing, and advice does not bound anything.
 *
 * THE POWERS RULE IS THE OPPOSITE, and deliberately so: an unpinned turn keeps its full toolbox, attended or
 * not. The two are not inconsistent because the mistakes are not comparable — a post cannot be taken back, and
 * an over-powered turn inside a container the owner can throw away can. Defaulting powers to nothing would also
 * have silently disarmed every automation already running the day this shipped, which is a migration dressed as
 * a security default. Owners opt IN to bounds, one card at a time.
 *
 * NAMING A PERSONA THAT DOES NOT EXIST DENIES EVERYTHING — accounts and powers both, and this is the one case
 * where the two rules agree. Falling back to "all accounts" would be perverse (the owner asked for one specific
 * persona, and answering a missing card with every account they own inverts the request into the exact accident
 * the layer exists to stop) and falling back to "the full toolbox" is worse: a Front Desk pinned to a read-only
 * card would quietly regain a shell the moment somebody deleted that card, with anonymous visitors driving it.
 * A card can go missing for entirely ordinary reasons — a workspace cloned before its personas were committed,
 * a card renamed in one place and not the other — so this is a state to REPORT loudly, not to assume away.
 *
 * NOTE ON WHAT THIS BOUNDS. Everything capability-shaped is enforced by ABSENCE: a filtered account has no
 * browser, a filtered connector has no credential in the shell's environment, a filtered computer and MCP
 * connection have no server mounted. The plain switches are enforced by taking tools out of the turn, which
 * holds for every tool the harness owns. Neither is a barrier against a session that has a SHELL and goes
 * looking — see PersonaPowersSchema, which says the same thing where the switch is set. */

// Why a turn ended up with the accounts and powers it did — for the log line, and for the surfaces that explain
// a turn that could not reach the account or the tool its prompt clearly expected.
export type PersonaReason =
    // No persona named, and someone is watching: every connected account, exactly as before this layer existed.
    | "attended-open"
    // A persona was named and found: exactly what its card says.
    | "persona"
    // Nobody watching and no persona named: no logged-in account, but the full toolbox.
    | "unattended-unpinned"
    // A persona was named and no card carries that id: nothing at all, of either kind.
    | "unknown-persona";

export interface TurnPersona {
    // The card that was named and found, for the turn's own note. Absent in every other case.
    readonly persona: Persona | undefined;
    // Whether this turn may act through a given capability. The ONE question the turn path asks about the
    // manifest, and it takes the whole entry rather than an id because the answer is per-KIND: an account is
    // asked about differently from a connector, and a kind this layer has no opinion on passes through.
    readonly allows: (capability: Capability) => boolean;
    // The shelves, fully resolved — no undefined fields, so no caller re-implements a default.
    readonly powers: PersonaPowers;
    // Where the turn works, when the card says. Absent ⇒ the surface's own answer, unchanged.
    readonly workspace: PersonaWorkspace | undefined;
    readonly reason: PersonaReason;
}

export interface TurnPersonaInput {
    readonly personas: readonly Persona[];
    // AgentTurn.actsAs — the persona the turn asked to wear.
    readonly actsAs: string | undefined;
    // AgentTurn.unattended — whether anyone is at a composer. The hinge the account rule turns on.
    readonly unattended: boolean;
}

// Every shelf open — what an unpinned turn gets, and the shape every caller can read without a fallback.
const FULL: PersonaPowers = PersonaPowersSchema.parse({});
// Every shelf shut. Only a named-but-missing card gets this; see the header for why that case is the strict one.
const NONE_POWERS: PersonaPowers = {
    files: "none",
    shell: false,
    code: false,
    web: false,
    browser: false,
    delegate: false,
    sandbox: false,
    connectors: [],
    computers: [],
    mcp: [],
};

/* The three answers that are not "read the card", spelled per KIND rather than as one blanket verdict.
 *
 * `ACCOUNTS_ONLY_DENIED` is the load-bearing one and the reason these are not two constants: an unattended wake
 * that named no persona loses every logged-in ACCOUNT and keeps everything else. A blanket deny here would take
 * its connectors, its computers and its MCP connections with them — which is the opposite of the powers rule in
 * the header, and would have silently disarmed every automation already running the day this shipped. */
const EVERYTHING = (): boolean => true;
const NOTHING = (): boolean => false;
// Identities count as accounts here: an identity's browser holds its email session and every account born from
// it, which is MORE credential than any single account — so the rule that takes accounts away from an
// unattended wake takes identities with them.
const ACCOUNTS_ONLY_DENIED = (capability: Capability): boolean => capability.kind !== "browser" && capability.kind !== "identity";

/* Which capability kinds each shelf answers for. A kind that is absent from this table is not something the
 * card has an opinion about — the runtimes an `agent` capability provides, the workspace's own devops and
 * monorepo entries — and passes through untouched, which is what keeps a new capability kind from being
 * silently denied to every persona the day it is added. */
const allowsCapability = (capability: Capability, card: Persona, powers: PersonaPowers): boolean => {
    switch (capability.kind) {
        // The signed-in browsers: the card's own `capabilities` list, and the field that predates the shelves.
        case "browser":
            return card.capabilities.includes(capability.id);
        /* An identity, by the same rule: the card names what it speaks through, and the identity's own tools
         * (its webmail, opening accounts) are a grant of their own. Naming an identity-born ACCOUNT without its
         * identity still works — the account brings its shared browser up by itself (browser-tools.ts groups by
         * profile owner) — so a card granting `reddit-work` grants that account's hands, and only a card
         * granting the identity grants the someone. */
        case "identity":
            return card.capabilities.includes(capability.id);
        // The connectors (GitHub, Discord, a database…) — their credentials reach the shell, so an id that is
        // not granted keeps its environment variables out of the turn entirely.
        case "cli":
            return powers.connectors === undefined || powers.connectors.includes(capability.id);
        case "host":
            return powers.computers === undefined || powers.computers.includes(capability.id);
        case "mcp":
            return powers.mcp === undefined || powers.mcp.includes(capability.id);
        default:
            return true;
    }
};

export const turnPersona = ({ personas, actsAs, unattended }: TurnPersonaInput): TurnPersona => {
    if (actsAs === undefined) {
        return unattended
            ? { persona: undefined, allows: ACCOUNTS_ONLY_DENIED, powers: FULL, workspace: undefined, reason: "unattended-unpinned" }
            : { persona: undefined, allows: EVERYTHING, powers: FULL, workspace: undefined, reason: "attended-open" };
    }
    const card = personas.find((entry) => entry.id === actsAs);
    if (card === undefined) {
        return { persona: undefined, allows: NOTHING, powers: NONE_POWERS, workspace: undefined, reason: "unknown-persona" };
    }
    // Parsed rather than spread so every field is populated from the schema's own defaults — one list of
    // defaults, in the contract, instead of a second one here that goes stale the first time a shelf is added.
    const powers = PersonaPowersSchema.parse(card.powers ?? {});
    return {
        persona: card,
        allows: (capability) => allowsCapability(capability, card, powers),
        powers,
        ...(card.workspace !== undefined ? { workspace: card.workspace } : { workspace: undefined }),
        reason: "persona",
    };
};

/* THE CAPABILITY MANIFEST AS THIS TURN MAY SEE IT — every entry the card grants, and nothing else.
 *
 * Narrowed HERE, before anything is built from it, rather than by trimming tool names afterwards. An account
 * filtered out is absent from the browser router's per-turn manifest, so its Chromium never launches, its
 * profile is never opened, and a call naming it is refused with the granted set spelled out; a connector
 * filtered out has no credential in the shell's environment; a computer or an MCP connection filtered out has
 * no server mounted. Each is absent from the turn rather than present-and-discouraged, which is the only
 * version of this that survives an agent misreading its instructions.
 *
 * The `browser` shelf is deliberately NOT applied here — it governs the credential-free browser, which is not a
 * capability at all (it holds nobody's account and is built from the image, see browser-tools.ts). */
export const personaCapabilities = (capabilities: readonly Capability[], persona: TurnPersona): Capability[] =>
    capabilities.filter((capability) => persona.allows(capability));

/* The shell environment as this turn may see it. A connector's credentials are suffixed with its capability id
 * (envSuffix, in the contract), so removing an ungranted connector means removing every variable carrying its suffix
 * — which takes the token out of the environment rather than asking the agent not to use it.
 *
 * Driven by the DENIED list rather than the granted one, because this environment carries more than connector
 * credentials: the PATH that makes extension CLIs resolve, an extension's own settings. Filtering to a granted
 * allowlist would take those with it and break a persona that never asked for anything of the sort. */
export const personaCliEnv = (
    cliEnv: Record<string, string>,
    capabilities: readonly Capability[],
    persona: TurnPersona,
    envSuffix: (id: string) => string,
): Record<string, string> => {
    const denied = capabilities
        .filter((capability) => capability.kind === "cli" && !persona.allows(capability))
        .map((capability) => `_${envSuffix(capability.id)}`);
    if (denied.length === 0) {
        return cliEnv;
    }
    return Object.fromEntries(Object.entries(cliEnv).filter(([key]) => !denied.some((suffix) => key.endsWith(suffix))));
};

/* WHICH BUILT-IN TOOLS THIS TURN DOES NOT GET — the shelves that are not capability-shaped, spelled as the tool
 * names the runtime knows them by.
 *
 * A DENYLIST RATHER THAN AN ALLOWLIST, which is the opposite of how the Front Desk's original bound was written
 * and is the right way round for a default-permissive card. An allowlist has to name every tool a session may
 * use — including the ones a runtime upgrade adds next month and every `mcp__…` name a connected account
 * mints — so the day it goes stale it goes stale by taking something away that the owner never chose to remove.
 * A denylist only has to name what the owner switched off, and anything new lands inside a shelf they already
 * answered. Both remove the tool from the model's context rather than refusing it at the call, so this reads to
 * the agent as a smaller toolbox and not as a wall it can push against.
 *
 * The raw per-automation allowlist still exists on top of this for the job that needs less than its card
 * (AutomationSchema.allowedTools) — that one is an allowlist because it is written against one prompt that is
 * not going to change under it. */
const EDIT_TOOLS = ["Edit", "Write", "NotebookEdit"];
const READ_TOOLS = ["Read", "Glob", "Grep", "NotebookRead"];
const SHELL_TOOLS = ["Bash", "BashOutput", "KillShell"];
const WEB_TOOLS = ["WebFetch", "WebSearch"];
const DELEGATE_TOOLS = ["Agent", "Task", "Workflow"];

/* THE SKILL OF A CAPABILITY THIS TURN CANNOT REACH, spelled as the runtime's own permission rule. Skill files
 * are written once per workspace (`.agents/skills/<capability id>`), so every turn discovers all of them —
 * including the ones for accounts this card was refused. Leaving those listed is how absence gets misread: an
 * unattended publish turn was offered the Reddit skill, followed it to tools that were never mounted for it,
 * searched, found nothing, and concluded the ACCOUNT was disconnected. It then failed two approved posts with
 * that sentence, and the sentence was wrong — the account was connected and simply not this turn's to use.
 *
 * `Skill(<name>)` is the same rule the SDK's own `skills` option compiles to, taken here as a DENYLIST because
 * the allowlist form would have to name every other skill the turn should keep: the workspace's, each plugin's,
 * and the ones the image bakes in. That list is exactly the kind that goes stale by silently removing something,
 * which is the failure this whole change exists to stop repeating.
 *
 * EVERY denied kind, not just accounts. A connector's cheatsheet without its credential and a computer's skill
 * without its server fail the same way — the skill reads as an offer and the tools behind it are not there. */
const deniedSkills = (persona: TurnPersona, capabilities: readonly Capability[]): string[] =>
    capabilities.filter((capability) => !persona.allows(capability)).map((capability) => `Skill(${capability.id})`);

// `capabilities` is the INSTALLED manifest, not the granted one: the whole point is to name what was filtered
// out of it. Passing the granted list would deny nothing, silently — which is why it is required rather than
// defaulted, so a call site cannot fall into that by omission.
export const personaDisallowedTools = (persona: TurnPersona, capabilities: readonly Capability[]): string[] => {
    const { powers } = persona;
    return [
        ...(powers.files === "none" ? [...READ_TOOLS, ...EDIT_TOOLS] : []),
        ...(powers.files === "read" ? EDIT_TOOLS : []),
        ...(powers.shell ? [] : SHELL_TOOLS),
        ...(powers.web ? [] : WEB_TOOLS),
        ...(powers.delegate ? [] : DELEGATE_TOOLS),
        ...deniedSkills(persona, capabilities),
    ];
};

/* The persona note's own heading, and the reason it has one at all: on a runtime with no system prompt to
 * append to (Pi, ACP) the sentence rides the user message instead, and every note that does has to be
 * recognisable there — the stripper anchors on the heading to take it back out of a restored transcript, and
 * the chat draws a row from it so the reader can see what the turn was told. It costs one line in the system
 * append where that is where it lands, which is one line of the same fact. */
export const PERSONA_NOTE_HEADER = "## Who this turn is acting as";

/* WHICH SYSTEM PROMPT THIS TURN RUNS ON, once the card has had its say — the sandbox's answer, or the card's
 * instead of it.
 *
 * Two ways a card falls back to the sandbox and they are deliberately the same answer: a card that never chose
 * (the field is absent, which is the default), and a card that chose "custom" and has no PROMPT.md yet. The second is a persona
 * half-made — somebody picked the option and has not typed the prompt — and running that turn on an empty
 * system prompt would be obeying a decision nobody finished making. `intentic` and `claude` need no text at
 * all: they name a base the composer already has.
 *
 * It takes the two settings values rather than the whole settings object so the fallback is visible at the call
 * site, and returns the pair the composer wants — there is no third thing to decide here. */
export const personaPrompt = (
    card: Persona | undefined,
    prompt: string | undefined,
    settings: { readonly systemPromptMode: SystemPromptMode; readonly systemPrompt: string },
): { readonly mode: SystemPromptMode; readonly systemPrompt: string } => {
    const mode = card?.systemPromptMode;
    if (mode === undefined || (mode === "custom" && prompt === undefined)) {
        return { mode: settings.systemPromptMode, systemPrompt: settings.systemPrompt };
    }
    // A card on a built-in base carries no text of its own — the base IS the answer — so the field the composer
    // reads under "custom" is empty rather than the sandbox's prompt leaking in behind a different base.
    return { mode, systemPrompt: mode === "custom" ? (prompt ?? "") : "" };
};

/* What to append to the turn's guidance when a persona is on. Kept SHORT: the model is already told, per
 * account, that its tools belong to exactly one account (see browser-skill.ts) — this says which of them the
 * owner meant for THIS turn, and where it is expected to work.
 *
 * The shelves are deliberately NOT narrated. A tool that is not in the turn's context needs no explanation, and
 * a paragraph listing what the agent cannot do is a paragraph inviting it to look for a way round — the absence
 * is the better teacher. What DOES need saying is anything the agent cannot discover by trying: which folders
 * it is expected to stay inside, because a refusal there arrives mid-task and reads as a broken tool.
 *
 * NOTHING HERE IS AUTHORED BY THE OWNER. Every sentence is derived from a field they SET, so the note cannot say
 * something they did not decide. The one exception is the desk the daemon writes for a Front Desk, whose manner
 * belongs to the product rather than to any workspace (front-desk.ts).
 *
 * Returns undefined when there is nothing worth saying: an open attended turn is the status quo, and a turn
 * with no accounts at all is better served by the tools simply not being there than by a paragraph about it. */
export const personaNote = (persona: TurnPersona): string | undefined => {
    const card = persona.persona;
    if (card === undefined) {
        return undefined;
    }
    const name = card.label ?? card.id;
    const folders = card.workspace?.folders;
    const scope =
        folders === undefined || folders.length === 0
            ? ``
            : ` You work inside ${folders.join(", ")} — file tools pointed anywhere else in the workspace are refused, so if the task needs a file outside that, say so rather than working around it.`;
    const desk = card.id === FRONT_DESK_PERSONA ? `\n\n${FRONT_DESK_GUIDANCE}` : ``;
    return (
        `${PERSONA_NOTE_HEADER}\n\n` +
        `You are acting as ${name}. Only that persona's accounts are available to you this turn; if a task needs a different one, stop and say so rather than using whatever is at hand.${scope}${desk}`
    );
};
