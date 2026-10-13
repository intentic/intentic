import type { CredentialReach, GrantedRole, MemberGrant } from "@intentic/sandbox-contract";
import { googleMailbox } from "../../../client/auth/signInMethods";

// What one grant sends the daemon, and the ways it can be malformed before it is sent. Pure, since the Access page's
// two writes (daemon first, platform second) and the person dialog that composes them all read it.

export interface AccessGrant {
    readonly email: string;
    readonly role: GrantedRole;
    // Area ids fencing what of the workspace this person reaches, and with it which assistants they may talk to;
    // absent is the whole workspace.
    readonly areas?: readonly string[];
}

// What a person's conversations may spend: every connected capability and stored secret, or the ones named.
export type ReachDraft = `all` | CredentialReach;

// One person's access as the dialog composes it: the tier, where they work, how they sign in, and what their
// conversations may spend. Sent whole, in one grant, so no half-made tier is ever on the daemon.
export interface AccessDraft {
    readonly role: GrantedRole;
    // Undefined is the whole workspace; a list, even empty, is the grant deciding.
    readonly areas: readonly string[] | undefined;
    readonly emailSignIn: boolean;
    readonly credentials: ReachDraft;
}

// The tiers in the order a reader climbs them, from the narrowest to the owner's own authority.
export const ROLE_ORDER: readonly GrantedRole[] = [`guest`, `viewer`, `collaborator`, `writer`, `maintainer`];

/** A maintainer holds the owner's operating authority: no folder fence, no credential reach is a boundary over it. */
export const roleBounded = (role: GrantedRole): boolean => role !== `maintainer`;

/** Whether this tier starts agent turns at all; a viewer only watches, so what it may spend decides nothing. */
export const roleDrivesAgents = (role: GrantedRole): boolean => role !== `viewer`;

/** Whether the tier has to name its areas: for a writer and a guest the fence is the tier, not a narrowing of it. */
export const roleNeedsAreas = (role: GrantedRole): boolean => role === `writer` || role === `guest`;

// The daemon's `/members` body. An area list rides on any tier below maintainer, and its ABSENCE is the whole
// workspace, so it is omitted rather than sent empty — an empty list would be a fence admitting nothing, which is a
// different grant. `emailSignIn` is sent only when the caller decides it (an invite, the dialog): absent, the daemon
// keeps what the row already says, so a re-grade never drops a person's email sign-in. `credentials` the same way:
// absent keeps the row's reach, so only a caller that decided it can widen or narrow it.
export const grantBody = (
    email: string,
    role: GrantedRole,
    areas: readonly string[] | undefined,
    emailSignIn?: boolean,
    credentials?: ReachDraft,
): MemberGrant => {
    const body: MemberGrant = { email, role };
    if (areas !== undefined && roleBounded(role)) {
        body.areas = [...areas];
    }
    if (emailSignIn !== undefined) {
        body.emailSignIn = emailSignIn;
    }
    // A maintainer is refused a list and holds every credential anyway; a viewer runs no turn, so its row keeps
    // whatever reach it had for the day it is graded up.
    if (credentials !== undefined && roleBounded(role) && roleDrivesAgents(role)) {
        body.credentials = credentials === `all` ? `all` : { capabilities: [...credentials.capabilities], secrets: [...credentials.secrets] };
    }
    return body;
};

/** The whole grant a dialog's draft makes. */
export const draftGrant = (email: string, draft: AccessDraft): MemberGrant =>
    grantBody(email, draft.role, roleBounded(draft.role) ? draft.areas : undefined, draft.emailSignIn, draft.credentials);

// Whether an invite lets its address sign in with an email code by default: yes, except for an address Google itself
// holds, whose owner has Google's sign-in and needs no second road the owner did not ask for.
export const emailSignInByDefault = (email: string): boolean => !googleMailbox(email);

// Whether the grant can be sent at all: the refusals the form makes itself rather than reading off the daemon.
// A writer's and a guest's areas are the tier rather than a narrowing of it — unfenced, a writer could change every
// file in the workspace and a guest could speak through every assistant in it. A guest's fence has one more thing to
// clear: it must reach an assistant, since a guest reaches nothing else and one that reaches none would sign in to a
// chat that answers nothing.
export const grantSendable = (role: GrantedRole, areas: readonly string[] | undefined, reaches: number): boolean => {
    const fenced = (areas ?? []).length > 0;
    if (role === `writer`) {
        return fenced;
    }
    return role !== `guest` || (fenced && reaches > 0);
};

/** How much of what is connected a reach holds, for the line a roster row says it in; undefined is all of it. */
export const reachCounts = (reach: ReachDraft): { readonly capabilities: number; readonly secrets: number } | undefined =>
    reach === `all` ? undefined : { capabilities: reach.capabilities.length, secrets: reach.secrets.length };

/** A reach with one subject switched on or off, keeping the order it was picked in. */
export const toggledReach = (reach: CredentialReach, kind: `capabilities` | `secrets`, subject: string, on: boolean): CredentialReach => {
    const held = reach[kind].filter((entry) => entry !== subject);
    return { ...reach, [kind]: on ? [...held, subject] : held };
};
