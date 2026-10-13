import {
    accessRefusal,
    type AgentAccess,
    type CredentialReach,
    type GrantedRole,
    type Member,
    type MemberAccess,
    type MemberGrant,
    memberAccess,
    tierOf,
} from "@intentic/sandbox-contract";
import { googleMailbox } from "../../../client/auth/signInMethods";

// One person's access as the People panel edits it, and the grant that writes it. Pure, since the panel, the roster's
// tiles and the Access page's two writes (daemon first, platform second) all read it.

// What a person's conversations may spend: every connected capability and stored secret, or the ones named.
export type ReachDraft = `all` | CredentialReach;

// Whether they manage the sandbox, whether their conversations run agents, where they see and where they edit by hand,
// how they sign in, and what their agents may spend. Each control in the panel changes one of these, and the whole of it
// is sent as one grant, so no half-made access ever reaches the daemon.
export interface AccessDraft extends MemberAccess {
    readonly emailSignIn: boolean;
    readonly credentials: ReachDraft;
}

/** Nothing to spend: what a new person starts with, so turning agents on later never hands over everything unasked. */
export const NO_REACH: CredentialReach = { capabilities: [], secrets: [] };

/** A new person: sees the workspace, starts nothing, spends nothing, signs in as an address of theirs usually would. */
export const newPerson = (email: string): AccessDraft => ({
    manage: false,
    agents: `off`,
    see: undefined,
    edit: `none`,
    emailSignIn: emailSignInByDefault(email),
    credentials: NO_REACH,
});

/** What the daemon holds for a person, or the platform's tier alone for a row the daemon never wrote. */
export const draftOf = (row: Member | undefined, recorded: GrantedRole): AccessDraft => ({
    ...memberAccess(row ?? { role: recorded }),
    emailSignIn: row?.emailSignIn === true,
    credentials: row?.credentials ?? `all`,
});

// The daemon's `/members` body. The role is the tier the access makes; a maintainer carries nothing else, since that
// tier is every other answer. An area list's ABSENCE is the whole workspace, so it is omitted rather than sent empty.
// Agents and edit are always sent, so the row says what the panel decided instead of what a role used to mean.
export const draftGrant = (email: string, draft: AccessDraft): MemberGrant => {
    const role = tierOf(draft);
    const body: MemberGrant = { email, role, emailSignIn: draft.emailSignIn };
    if (draft.manage) {
        return body;
    }
    body.agents = draft.agents;
    if (draft.see !== undefined) {
        body.areas = [...draft.see];
    }
    if (draft.edit !== `none`) {
        body.edit = draft.edit === `all` ? `all` : [...draft.edit];
    }
    body.credentials = draft.credentials === `all` ? `all` : { capabilities: [...draft.credentials.capabilities], secrets: [...draft.credentials.secrets] };
    return body;
};

// Why the panel holds a draft back instead of saving it, as the key of the line it shows. A guest-like chat needs areas
// whose assistants it talks to; a narrowed scope with nothing ticked is a fence admitting nothing, which nobody means.
export type DraftProblem = `pickSeeArea` | `pickEditArea` | `chatNeedsArea` | `chatReachesNobody` | `editOutsideSee`;

export const draftProblem = (draft: AccessDraft, reaches: number): DraftProblem | undefined => {
    if (draft.manage) {
        return undefined;
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
    return accessRefusal(draft) === undefined ? undefined : `editOutsideSee`;
};

/** The one word a person's tile says of them. */
export type AccessWord = `manages` | `chats` | `edits` | `runsAgents` | `sees`;

export const accessWord = (access: MemberAccess): AccessWord => {
    const tier = tierOf(access);
    return ({ maintainer: `manages`, guest: `chats`, writer: `edits`, collaborator: `runsAgents`, viewer: `sees` } as const)[tier];
};

/** Whether an access's conversations run turns at all, and so whether what they may spend means anything. */
export const drivesAgents = (agents: AgentAccess): boolean => agents !== `off`;

// Whether an invite lets its address sign in with an email code by default: yes, except for an address Google itself
// holds, whose owner has Google's sign-in and needs no second road the owner did not ask for.
export const emailSignInByDefault = (email: string): boolean => !googleMailbox(email);

/** A reach with one subject switched on or off, keeping the order it was picked in. */
export const toggledReach = (reach: CredentialReach, kind: `capabilities` | `secrets`, subject: string, on: boolean): CredentialReach => {
    const held = reach[kind].filter((entry) => entry !== subject);
    return { ...reach, [kind]: on ? [...held, subject] : held };
};
