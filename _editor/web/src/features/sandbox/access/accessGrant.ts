import {
    accessRefusal,
    type AgentAccess,
    type CredentialReach,
    MANAGE_RIGHTS,
    type ManageRight,
    type Member,
    type MemberAccess,
    type MemberGrant,
    memberAccess,
    tierOf,
} from "@intentic/sandbox-contract/schemas/members";
import type { GrantedRole } from "@intentic/sandbox-contract/schemas/shared";
import type { ToolCeiling } from "@intentic/sandbox-contract/schemas/tool-ceiling";
import { googleMailbox } from "../../../client/auth/signInMethods";

// One person's access as the People panel edits it, and the grant that writes it. Pure, since the panel, the roster's
// tiles and the Access page's two writes (daemon first, platform second) all read it.

// What a person's conversations may spend: every connected capability and stored secret, or the ones named.
export type ReachDraft = `all` | CredentialReach;

// Which AI accounts a person's conversations run on: every one, or the ones named, keyed as the contract's
// `aiAccountKey` (`provider:account`, or a provider alone for one holding no accounts of its own).
export type AiAccountsDraft = `all` | readonly string[];

// Whether they manage the sandbox, whether their conversations run agents, where they see and where they edit by hand,
// how they sign in, and what their agents may spend. Each control in the panel changes one of these, and the whole of it
// is sent as one grant, so no half-made access ever reaches the daemon.
export interface AccessDraft extends MemberAccess {
    readonly profile?: string | undefined;
    readonly tools?: ToolCeiling | undefined;
    readonly assistants?: readonly string[] | undefined;
    readonly emailSignIn: boolean;
    readonly credentials: ReachDraft;
    readonly aiAccounts: AiAccountsDraft;
}

/** Nothing to spend: what a new person starts with, so turning agents on later never hands over everything unasked. */
export const NO_REACH: CredentialReach = { capabilities: [], secrets: [] };

/**
 * A new person: sees the workspace, starts nothing, spends no connection or secret, signs in as an address of theirs
 * usually would. Runs on every AI account once agents are turned on: an empty list would make turning them on do
 * nothing, and which accounts pay for their turns is a narrowing the owner makes on purpose.
 */
export const newPerson = (email: string): AccessDraft => ({
    manage: false,
    agents: `off`,
    see: undefined,
    edit: `none`,
    emailSignIn: emailSignInByDefault(email),
    credentials: NO_REACH,
    aiAccounts: `all`,
});

/** What the daemon holds for a person, or the platform's tier alone for a row the daemon never wrote. */
export const draftOf = (row: Member | undefined, recorded: GrantedRole): AccessDraft => ({
    profile: row?.profile,
    tools: row?.tools,
    assistants: row?.assistants,
    ...memberAccess(row ?? { role: recorded }),
    emailSignIn: row?.emailSignIn === true,
    credentials: row?.credentials ?? `all`,
    aiAccounts: row?.aiAccounts ?? `all`,
});

// What a person's conversations spend, as a grant sends it: always said, so the row holds what the panel shows.
const spendOf = (draft: AccessDraft): Pick<MemberGrant, `credentials` | `aiAccounts`> => ({
    credentials: draft.credentials === `all` ? `all` : { capabilities: [...draft.credentials.capabilities], secrets: [...draft.credentials.secrets] },
    aiAccounts: draft.aiAccounts === `all` ? `all` : [...draft.aiAccounts],
});

/**
 * The parts of the sandbox a way of working can be given besides its own work: none to a person who only chats or works
 * through their home conversation (the contract refuses them), and AI accounts of their own only to someone whose agents
 * run, since an account nothing runs on is no answer.
 */
export const rightsOffered = (agents: AgentAccess): readonly ManageRight[] => {
    if (agents === `chat` || agents === `home`) {
        return [];
    }
    return drivesAgents(agents) ? MANAGE_RIGHTS : MANAGE_RIGHTS.filter((right) => right !== `ownAccounts`);
};

/** The rights a draft holds that its way of working can carry, in the contract's order; the rest are dropped with it. */
export const rightsFor = (agents: AgentAccess, manages: readonly ManageRight[] | undefined): ManageRight[] =>
    rightsOffered(agents).filter((right) => manages?.includes(right) === true);

// The daemon's `/members` body. The role is the tier the access makes; a maintainer carries only what its conversations
// may spend besides, since that tier is every other answer, every right included. An area list's ABSENCE is the whole
// workspace, so it is omitted rather than sent empty. Agents, edit and rights are always sent, so the row says what the
// panel decided instead of what a role used to mean or what the row held before; rights ride beside a profile too, since
// a profile never carries them.
export const draftGrant = (email: string, draft: AccessDraft): MemberGrant => {
    const role = tierOf(draft);
    const body: MemberGrant = { email, role, emailSignIn: draft.emailSignIn };
    if (draft.manage) {
        return { ...body, ...spendOf(draft) };
    }
    body.manages = rightsFor(draft.agents, draft.manages);
    if (draft.profile !== undefined) {
        body.profile = draft.profile;
        return body;
    }
    if (draft.tools !== undefined) { body.tools = draft.tools; }
    if (draft.assistants !== undefined) { body.assistants = [...draft.assistants]; }
    body.agents = draft.agents;
    if (draft.see !== undefined) {
        body.areas = [...draft.see];
    }
    if (draft.edit !== `none`) {
        body.edit = draft.edit === `all` ? `all` : [...draft.edit];
    }
    // Only a home-only person's home lands by itself, and only when said: silence takes it back.
    if (draft.agents === `home` && draft.lands === true) {
        body.lands = true;
    }
    return { ...body, ...spendOf(draft) };
};

// Why the panel holds a draft back instead of saving it, as the key of the line it shows. A guest-like chat needs areas
// whose assistants it talks to; a narrowed scope with nothing ticked is a fence admitting nothing, which nobody means.
export type DraftProblem = `pickSeeArea` | `pickEditArea` | `chatNeedsArea` | `chatReachesNobody` | `editOutsideSee` | `pickAiAccount`;

// Agents that may run on no AI account run nothing: held back as a narrowed fence admitting nothing is.
const noAiAccount = (draft: AccessDraft): boolean => draft.aiAccounts !== `all` && draft.aiAccounts.length === 0;

export const draftProblem = (draft: AccessDraft, reaches: number): DraftProblem | undefined => {
    if (draft.manage) {
        return noAiAccount(draft) ? `pickAiAccount` : undefined;
    }
    if (draft.agents === `chat`) {
        if ((draft.see ?? []).length === 0) {
            return `chatNeedsArea`;
        }
        return reaches === 0 ? `chatReachesNobody` : undefined;
    }
    if (draft.see !== undefined && draft.see.length === 0) {
        return `pickSeeArea`;
    }
    if (draft.edit !== `none` && draft.edit !== `all` && draft.edit.length === 0) {
        return `pickEditArea`;
    }
    if (drivesAgents(draft.agents) && noAiAccount(draft)) {
        return `pickAiAccount`;
    }
    return accessRefusal(draft) === undefined ? undefined : `editOutsideSee`;
};

/** The one word a person's tile says of them. */
export type AccessWord = `manages` | `chats` | `homeOnly` | `edits` | `runsAgents` | `sees`;

export const accessWord = (access: MemberAccess): AccessWord => {
    if (!access.manage && access.agents === `home`) {
        return `homeOnly`;
    }
    const tier = tierOf(access);
    return ({ maintainer: `manages`, guest: `chats`, writer: `edits`, collaborator: `runsAgents`, viewer: `sees` } as const)[tier];
};

/** Whether an access's conversations run turns at all, and so whether what they may spend means anything. */
export const drivesAgents = (agents: AgentAccess): boolean => agents !== `off`;

// Whether an invite lets its address sign in with an email code by default: yes, except for an address Google itself
// holds, whose owner has Google's sign-in and needs no second road the owner did not ask for.
export const emailSignInByDefault = (email: string): boolean => !googleMailbox(email);
