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

// A card answers four questions together: accounts, tool shelves, workspace, and prompt. Accounts default to nothing
// for an unpinned unattended turn; powers default to everything regardless, since owners opt into bounds one card at a
// time. An unknown persona denies both, rather than assuming a safe default.

// Why a turn got the accounts and powers it did; feeds the log line and surfaces explaining a blocked tool.
export type PersonaReason =
    // No persona named, someone watching: every connected account.
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
    // Whether this turn may act through a capability; takes the whole entry, since the rule differs per kind.
    readonly allows: (capability: Capability) => boolean;
    // The shelves, fully resolved, no undefined fields, so no caller re-implements a default.
    readonly powers: PersonaPowers;
    // Where the turn works, when the card says. Absent means the surface's own answer, unchanged.
    readonly workspace: PersonaWorkspace | undefined;
    readonly reason: PersonaReason;
}

export interface TurnPersonaInput {
    readonly personas: readonly Persona[];
    // AgentTurn.actsAs, the persona the turn asked to wear.
    readonly actsAs: string | undefined;
    // AgentTurn.unattended, whether anyone is at a composer. The hinge the account rule turns on.
    readonly unattended: boolean;
}

// Every shelf open, what an unpinned turn gets, and the shape every caller can read without a fallback.
const FULL: PersonaPowers = PersonaPowersSchema.parse({});
// Every shelf shut; only a named-but-missing card gets this.
const NONE_POWERS: PersonaPowers = {
    files: "none",
    shell: false,
    code: false,
    web: false,
    browser: false,
    delegate: false,
    sandbox: false,
    connectors: [],
    devices: [],
    mcp: [],
};

// Per-kind verdicts, not one blanket one: an unpinned wake denies accounts only, keeping the rest.
const EVERYTHING = (): boolean => true;
const NOTHING = (): boolean => false;
// Identities count as accounts: an identity's browser holds every account born from it.
const ACCOUNTS_ONLY_DENIED = (capability: Capability): boolean => capability.kind !== "browser" && capability.kind !== "identity";

// Which capability kinds a card has an opinion about; a kind absent from this switch (an agent runtime, a devops entry)
// passes through untouched, so a new kind is never silently denied.
const allowsCapability = (capability: Capability, card: Persona, powers: PersonaPowers): boolean => {
    switch (capability.kind) {
        // The signed-in browsers: the card's own `capabilities` list, and the field that predates the shelves.
        case "browser":
            return card.capabilities.includes(capability.id);
        // Granting an account (`reddit-work`) grants its hands; granting the identity itself grants the someone.
        case "identity":
            return card.capabilities.includes(capability.id);
        // Connector credentials reach the shell; an ungranted id keeps its env vars out of the turn entirely.
        case "cli":
            return powers.connectors === undefined || powers.connectors.includes(capability.id);
        case "host":
            return powers.devices === undefined || powers.devices.includes(capability.id);
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
    // Parsed, not spread, so defaults come from the schema's one list instead of a second one that could go stale.
    const powers = PersonaPowersSchema.parse(card.powers ?? {});
    return {
        persona: card,
        allows: (capability) => allowsCapability(capability, card, powers),
        powers,
        ...(card.workspace !== undefined ? { workspace: card.workspace } : { workspace: undefined }),
        reason: "persona",
    };
};

// Capability manifest as this turn may see it: narrowed before anything is built, so a filtered account's browser never
// launches, rather than present-and-discouraged. The credential-free `browser` shelf isn't a capability here.
export const personaCapabilities = (capabilities: readonly Capability[], persona: TurnPersona): Capability[] =>
    capabilities.filter((capability) => persona.allows(capability));

// Removes every env var suffixed with an ungranted connector's id, not merely discouraging its use. Driven by the
// denied list, since the environment carries more than connector credentials (PATH, extension settings).
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

// Denylist, not allowlist: an allowlist would need every future tool named, and goes stale by removing access.
const EDIT_TOOLS = ["Edit", "Write", "NotebookEdit"];
const READ_TOOLS = ["Read", "Glob", "Grep", "NotebookRead"];
const SHELL_TOOLS = ["Bash", "BashOutput", "KillShell"];
const WEB_TOOLS = ["WebFetch", "WebSearch"];
const DELEGATE_TOOLS = ["Agent", "Task", "Workflow"];

// Skill files are written once per workspace, so a refused account's skill stays visible; deny `Skill(<name>)` too, or
// the tools' absence reads as a broken login. Same denylist rule as the SDK's own `skills` option.
const deniedSkills = (persona: TurnPersona, capabilities: readonly Capability[]): string[] =>
    capabilities.filter((capability) => !persona.allows(capability)).map((capability) => `Skill(${capability.id})`);

// `capabilities` is the installed manifest, not the granted one: the point is to name what got filtered out. Required,
// not defaulted, so a call site can't silently pass the granted list and deny nothing.
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

// Heading a transcript stripper anchors on; some runtimes append this note to the user message, not a prompt.
export const PERSONA_NOTE_HEADER = "## Who this turn is acting as";
// The chat-row title, paired with the header above.
export const PERSONA_NOTE_TITLE = "Who this turn is acting as";

// Falls back to the sandbox's prompt both when the field is absent and when "custom" has no PROMPT.md yet, a half-made
// decision, not one to run blank. `intentic`/`claude` need no text; they name a base the composer already has.
export const personaPrompt = (
    card: Persona | undefined,
    prompt: string | undefined,
    settings: { readonly systemPromptMode: SystemPromptMode; readonly systemPrompt: string },
): { readonly mode: SystemPromptMode; readonly systemPrompt: string } => {
    const mode = card?.systemPromptMode;
    if (mode === undefined || (mode === "custom" && prompt === undefined)) {
        return { mode: settings.systemPromptMode, systemPrompt: settings.systemPrompt };
    }
    // A built-in base carries no text; the "custom" field stays empty, not leaking the sandbox's prompt behind it.
    return { mode, systemPrompt: mode === "custom" ? (prompt ?? "") : "" };
};

// What to append when a persona is on: which accounts, and where it works, kept short since missing tools already teach
// by absence. Folders are the exception, narrated since a mid-task path refusal reads as broken.
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
            : ` You work inside ${folders.join(", ")}, file tools pointed anywhere else in the workspace are refused, so if the task needs a file outside that, say so rather than working around it.`;
    const desk = card.id === FRONT_DESK_PERSONA ? `\n\n${FRONT_DESK_GUIDANCE}` : ``;
    return (
        `${PERSONA_NOTE_HEADER}\n\n` +
        `You are acting as ${name}. Only that persona's accounts are available to you this turn; if a task needs a different one, stop and say so rather than using whatever is at hand.${scope}${desk}`
    );
};
