import type { Capability } from "@intentic/sandbox-contract/schemas/capabilities";
import { DELEGATE_TOOL_NAMES, READ_TOOL_NAMES, SHELL_TOOL_NAMES, WEB_TOOL_NAMES, WRITE_TOOL_NAMES } from "../rules/tool-vocabulary.js";
import type { AccessProfile } from "@intentic/sandbox-contract/schemas/access-profiles";
import type { Area } from "@intentic/sandbox-contract/schemas/areas";
import { type Fence, fenceIntersection } from "@intentic/sandbox-contract/policy/fence-paths";
import { isSignedInAccount, roleAllowsCapability } from "@intentic/sandbox-contract/policy/role-capability";
import {
    type BuiltInRoleId,
    defaultRole,
    isBuiltInRole,
    NO_ACCOUNTS_ROLE,
    type Role,
    type RolePowers,
    type RoleWorkspace,
    VISITOR_CHAT_ROLE,
    RolePowersSchema,
} from "@intentic/sandbox-contract/schemas/roles";
import type { SystemPromptMode } from "@intentic/sandbox-contract/schemas/settings";
import { capPowers, ceilingLimits, type ToolCeiling } from "@intentic/sandbox-contract/schemas/tool-ceiling";
import { foldersOf } from "../areas/areas-store.js";
import type { TurnNote } from "@intentic/sandbox-contract/events/transcript";
import { VISITOR_CHAT_GUIDANCE } from "./visitor-chat.js";

// A role answers three questions together: which signed-in accounts it speaks through, where it opens, and what it
// is told. Every turn wears one: a card, or one of the two built-ins (schemas/roles.ts), All accounts or No accounts,
// which a turn naming no card wears by whether a person is watching. Naming a built-in wears it whoever is watching. An
// unknown card denies both accounts and tools, rather than assuming a safe default.
// What else a turn wearing it may reach is access: the access profiles listing the card join the principal chain
// (access/principal-chain.ts), so its shelves come from the ceiling (capRole below), its connections from the
// credential reach, and its folders from those profiles' areas (roleFence below). No card answer lifts any of them.

// Why a turn got the accounts and powers it did; feeds the log line and surfaces explaining a blocked tool.
export type RoleReason =
    // The All accounts built-in (id `full-access`): every connected account. What a watched turn naming no card wears.
    | "full-access"
    // The No accounts built-in: no signed-in account. What an unwatched turn naming no card wears.
    | "no-accounts"
    // A card was named and found: the accounts it speaks through, inside its access.
    | "role"
    // A card was named and none carries that id: nothing at all, of either kind.
    | "unknown-role";

export interface TurnRole {
    // The card that was named and found, for the turn's own note and kit. Absent for a built-in and an unknown name.
    readonly role: Role | undefined;
    // The built-in this turn wears, named or by default; absent when it wears a card or an unknown name.
    readonly builtIn?: BuiltInRoleId;
    // Whether this turn may act through a capability; takes the whole entry, since the rule differs per kind.
    readonly allows: (capability: Capability) => boolean;
    // The shelves, fully resolved, no undefined fields, so no caller re-implements a default.
    readonly powers: RolePowers;
    // Where the turn works, when the role says. Absent means the surface's own answer, unchanged.
    readonly workspace: RoleWorkspace | undefined;
    // Folders this turn's file tools may touch, already the tighter of the areas its role's access fences it to and the
    // fence the conversation inherited from whoever started it. Undefined is the whole workspace.
    // Resolved here rather than at each surface, so no caller can enforce one of the two halves and miss the other.
    readonly fence: Fence;
    readonly reason: RoleReason;
}

export interface TurnRoleInput {
    readonly roles: readonly Role[];
    // AgentTurn.actsAs, the role the turn asked to wear.
    readonly actsAs: string | undefined;
    // AgentTurn.unattended, whether anyone is at a composer: which built-in a turn naming no card wears.
    readonly unattended: boolean;
    // The fence the conversation carries, fixed when it was started from whoever started it. Undefined means its
    // starter was unfenced, which is every conversation an owner or a maintainer opens.
    readonly fence?: Fence;
    // The folders the role's access fences it to (roleFence); undefined is no fence of its own.
    readonly roleFence?: Fence;
}

/**
 * The folders the access profiles listing a card fence it to: each profile's areas, held together. Undefined when no
 * profile listing it names areas, which is the whole workspace; a profile naming none of the areas that exist fences it
 * to nothing.
 */
export const roleFence = (id: string | undefined, profiles: readonly Pick<AccessProfile, "areas" | "roles">[], areas: readonly Area[]): Fence =>
    id === undefined || isBuiltInRole(id)
        ? undefined
        : profiles
              .filter((profile) => profile.roles?.includes(id) === true && profile.areas !== undefined)
              .reduce<Fence>((fence, profile) => fenceIntersection(fence, foldersOf(areas, profile.areas)), undefined);

// Every shelf open, what both built-ins get, and the shape every caller can read without a fallback.
const FULL: RolePowers = RolePowersSchema.parse({});
// Every shelf shut; only a named-but-missing role gets this.
const NONE_POWERS: RolePowers = {
    files: "none",
    shell: false,
    code: false,
    web: false,
    browser: false,
    delegate: false,
    sandbox: false,
    extensions: [],
};

// Per-kind verdicts, not one blanket one: No accounts denies accounts only, keeping the rest.
const EVERYTHING = (): boolean => true;
const NOTHING = (): boolean => false;
// Identities count as accounts: an identity's browser holds every account born from it.
const ACCOUNTS_ONLY_DENIED = (capability: Capability): boolean => !isSignedInAccount(capability.kind);

// A built-in, worn: the whole toolbox and the conversation's own fence, with every account or none.
const wearBuiltIn = (id: BuiltInRoleId, fence: Fence): TurnRole =>
    id === NO_ACCOUNTS_ROLE
        ? { role: undefined, builtIn: id, allows: ACCOUNTS_ONLY_DENIED, powers: FULL, workspace: undefined, fence, reason: "no-accounts" }
        : { role: undefined, builtIn: id, allows: EVERYTHING, powers: FULL, workspace: undefined, fence, reason: "full-access" };

export const turnRole = ({ roles, actsAs, unattended, fence, roleFence: held }: TurnRoleInput): TurnRole => {
    // Checked before the cards: a built-in id is reserved, so a card that somehow carries one never shadows it.
    if (actsAs === undefined || isBuiltInRole(actsAs)) {
        return wearBuiltIn(actsAs ?? defaultRole(unattended), fence);
    }
    const role = roles.find((entry) => entry.id === actsAs);
    if (role === undefined) {
        return { role: undefined, allows: NOTHING, powers: NONE_POWERS, workspace: undefined, fence, reason: "unknown-role" };
    }
    return {
        role,
        allows: (capability) => roleAllowsCapability(capability, role.capabilities),
        powers: FULL,
        workspace: role.workspace,
        // The role's access narrows the conversation's fence, never widens it: an area its starter cannot see drops
        // out here rather than opening.
        fence: fenceIntersection(fence, held),
        reason: "role",
    };
};

// The ceiling of everything a turn acts for laid over its shelves (access/principal-chain.ts,
// docs/architecture/access.md): the people, the services, the role's own access profiles and the organisation, each
// shelf the lowest of them. The two capabilities a shelf decides (making sandboxes on the sandbox shelf, a linked
// sandbox on the delegate one) follow the capped shelves too.
export const capRole = (role: TurnRole, ceiling: ToolCeiling | undefined): TurnRole => {
    if (!ceilingLimits(ceiling)) {
        return role;
    }
    const powers = capPowers(role.powers, ceiling);
    const shelfAllows = (capability: Capability): boolean =>
        capability.kind === "fleet" ? powers.sandbox : capability.kind === "link" ? powers.delegate : true;
    return { ...role, powers, allows: (capability) => role.allows(capability) && shelfAllows(capability) };
};

// Whether this role may start agents elsewhere: a child is a whole agent holding shell and write, so a narrowed
// role must not reach them by proxy. One predicate, since every runtime's arm decides the spawn door the same way.
export const mayDelegate = (role: TurnRole): boolean => role.powers.delegate && role.powers.shell && role.powers.files === "write";

// Capability manifest as this turn may see it: narrowed before anything is built, so a filtered account's browser never
// launches, rather than present-and-discouraged. The credential-free `browser` shelf isn't a capability here.
export const roleCapabilities = (capabilities: readonly Capability[], role: TurnRole): Capability[] =>
    capabilities.filter((capability) => role.allows(capability));

// The signed-in accounts this turn lost, read from the other side of the same predicate — what the note below has to
// name. Accounts only: a filtered connector or device teaches by the absence of a tool it never had, while an account's
// skill file stays on disk naming it (deniedSkills says why), which is what makes THIS absence read as a broken login.
// The owner's own browser counts: its skill stays on disk too.
export const roleWithheldAccounts = (capabilities: readonly Capability[], role: TurnRole): Capability[] =>
    capabilities.filter((capability) => isSignedInAccount(capability.kind) && !role.allows(capability));

export const UNATTENDED_ACCOUNTS_TITLE = "This turn reaches no signed-in account";

// What a turn wearing No accounts owes itself when the built-in takes its accounts away: usually an unwatched one that
// named no card, sometimes a person who picked it on purpose.
//
// Absence teaches nothing here, and three silences compound: the skill files stay on disk still advertising the
// account, `Skill(<id>)` refuses with the SDK's generic permission sentence, and `secrets gates` — the one diagnostic
// this sandbox points at withheld credentials — knows only the owner-approval path and answers that nothing needs
// approval. The fence is right; being silent about it is not.
//
// It names the boundary as well as the loss: this rule takes signed-in browsers only, so a turn reading it must not
// conclude that the connector credentials still in its environment are gone too.
//
// Only for No accounts: a turn wearing a card is told what it is wearing by roleNote, which is the same sentence
// from the other end.
export const unattendedAccountsNote = (role: TurnRole, withheld: readonly Capability[]): TurnNote | undefined => {
    if (role.reason !== "no-accounts" || withheld.length === 0) {
        return undefined;
    }
    return {
        title: UNATTENDED_ACCOUNTS_TITLE,
        text:
            `This turn acts as the built-in role No accounts — usually because nobody is watching it (a schedule, a queue ` +
            `or another agent started it) and it named no role — so the sandbox's signed-in accounts are not loaded into ` +
            `it: ${withheld.map((capability) => `\`${capability.id}\``).join(", ")}.\n\n` +
            `They are connected and working. Their tools are absent and their skills refuse, and that is THIS RULE, not a broken ` +
            `login: do not reconnect them, do not sign in by hand, and do not reach for a token to work around them. A turn ` +
            `acting as All accounts, or as a role that holds the account, gets them, so if the work needs one, do everything ` +
            `else first and say plainly in your summary which account it was waiting on.\n\n` +
            `That list is the whole of what this rule takes, and it is signed-in browsers only. Every connector credential in ` +
            `your environment and every skill built on one is untouched and yours to use.`,
    };
};

// Removes every env var suffixed with an ungranted connector's id, not merely discouraging its use. Driven by the
// denied list, since the environment carries more than connector credentials (PATH, extension settings).
export const roleCliEnv = (
    cliEnv: Record<string, string>,
    capabilities: readonly Capability[],
    role: TurnRole,
    envSuffix: (id: string) => string,
): Record<string, string> => {
    const denied = capabilities
        .filter((capability) => capability.kind === "cli" && !role.allows(capability))
        .map((capability) => `_${envSuffix(capability.id)}`);
    if (denied.length === 0) {
        return cliEnv;
    }
    return Object.fromEntries(Object.entries(cliEnv).filter(([key]) => !denied.some((suffix) => key.endsWith(suffix))));
};

// Denylist, not allowlist: an allowlist would need every future tool named, and goes stale by removing access. In the
// one tool vocabulary (rules/tool-vocabulary.ts), which every runtime's gate translates its own names into.
const EDIT_TOOLS = WRITE_TOOL_NAMES;
const READ_TOOLS = READ_TOOL_NAMES;
const SHELL_TOOLS = SHELL_TOOL_NAMES;
const WEB_TOOLS = WEB_TOOL_NAMES;
const DELEGATE_TOOLS = DELEGATE_TOOL_NAMES;

// Skill files are written once per workspace, so a refused account's skill stays visible; deny `Skill(<name>)` too, or
// the tools' absence reads as a broken login. Same denylist rule as the SDK's own `skills` option.
const deniedSkills = (role: TurnRole, capabilities: readonly Capability[]): string[] =>
    capabilities.filter((capability) => !role.allows(capability)).map((capability) => `Skill(${capability.id})`);

// `capabilities` is the installed manifest, not the granted one: the point is to name what got filtered out. Required,
// not defaulted, so a call site can't silently pass the granted list and deny nothing.
export const roleDisallowedTools = (role: TurnRole, capabilities: readonly Capability[]): string[] => {
    const { powers } = role;
    return [
        ...(powers.files === "none" ? [...READ_TOOLS, ...EDIT_TOOLS] : []),
        ...(powers.files === "read" ? EDIT_TOOLS : []),
        ...(powers.shell ? [] : SHELL_TOOLS),
        ...(powers.web ? [] : WEB_TOOLS),
        ...(powers.delegate ? [] : DELEGATE_TOOLS),
        ...deniedSkills(role, capabilities),
    ];
};

// Heading a transcript stripper anchors on; some runtimes append this note to the user message, not a prompt.
export const ROLE_NOTE_HEADER = "## Who this turn is acting as";
// The chat-row title, paired with the header above.
export const ROLE_NOTE_TITLE = "Who this turn is acting as";

// Falls back to the sandbox's prompt both when the field is absent and when "custom" has no PROMPT.md yet, a half-made
// decision, not one to run blank. `intentic`/`claude` need no text; they name a base the composer already has.
export const rolePrompt = (
    role: Role | undefined,
    prompt: string | undefined,
    settings: { readonly systemPromptMode: SystemPromptMode; readonly systemPrompt: string },
): { readonly mode: SystemPromptMode; readonly systemPrompt: string } => {
    const mode = role?.systemPromptMode;
    if (mode === undefined || (mode === "custom" && prompt === undefined)) {
        return { mode: settings.systemPromptMode, systemPrompt: settings.systemPrompt };
    }
    // A built-in base carries no text; the "custom" field stays empty, not leaking the sandbox's prompt behind it.
    return { mode, systemPrompt: mode === "custom" ? (prompt ?? "") : "" };
};

// What to append when a role is on: which accounts, and where it works, kept short since missing tools already teach
// by absence. Folders are the exception, narrated since a mid-task path refusal reads as broken.
export const roleNote = (turn: TurnRole): string | undefined => {
    const role = turn.role;
    if (role === undefined) {
        return undefined;
    }
    const name = role.label ?? role.id;
    // The resolved fence, not the role's own folder list: the turn is told the folders it will actually be
    // refused outside of, which is the role's folders already narrowed by whoever started the conversation.
    const folders = turn.fence;
    const scope =
        folders === undefined || folders.length === 0
            ? ``
            : ` You work inside ${folders.join(", ")}, file tools pointed anywhere else in the workspace are refused, so if the task needs a file outside that, say so rather than working around it.`;
    const guest = role.id === VISITOR_CHAT_ROLE ? `\n\n${VISITOR_CHAT_GUIDANCE}` : ``;
    return (
        `${ROLE_NOTE_HEADER}\n\n` +
        `You are acting as ${name}. Only that role's accounts are available to you this turn; if a task needs a different one, stop and say so rather than using whatever is at hand.${scope}${guest}`
    );
};
