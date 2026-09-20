import type { GrantedRole } from "@intentic/sandbox-contract";

// What one grant sends the daemon, and the one way it can be malformed before it is sent. Pure, since the Access
// page's two writes (daemon first, platform second) both read it, and a desk with no card to wear is a sign-in the
// daemon refuses on the spot.

export interface AccessGrant {
    readonly email: string;
    readonly role: GrantedRole;
    // Persona ids, on a desk grant only.
    readonly desks?: readonly string[];
    // Area ids fencing what of the workspace this person reaches; absent is the whole workspace.
    readonly areas?: readonly string[];
}

// The daemon's `/members` body: desks ride only on a desk, whatever the picker held when the tier changed. An area
// list rides on any tier below maintainer, and its ABSENCE is the whole workspace, so it is omitted rather than sent
// empty — an empty list would be a fence admitting nothing, which is a different grant.
export const grantBody = (email: string, role: GrantedRole, desks: readonly string[], areas: readonly string[] | undefined): AccessGrant => ({
    email,
    role,
    ...(role === `desk` ? { desks: [...desks] } : {}),
    ...(areas === undefined || role === `maintainer` ? {} : { areas: [...areas] }),
});

// Whether the grant can be sent at all; the one refusal the form makes itself rather than reading off the daemon.
export const grantSendable = (role: GrantedRole, desks: readonly string[]): boolean => role !== `desk` || desks.length > 0;
