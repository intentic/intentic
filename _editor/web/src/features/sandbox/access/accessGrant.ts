import type { GrantedRole } from "@intentic/sandbox-contract";

// What one grant sends the daemon, and the ways it can be malformed before it is sent. Pure, since the Access page's
// two writes (daemon first, platform second) both read it.

export interface AccessGrant {
    readonly email: string;
    readonly role: GrantedRole;
    // Area ids fencing what of the workspace this person reaches, and with it which assistants they may talk to;
    // absent is the whole workspace.
    readonly areas?: readonly string[];
}

// The daemon's `/members` body. An area list rides on any tier below maintainer, and its ABSENCE is the whole
// workspace, so it is omitted rather than sent empty — an empty list would be a fence admitting nothing, which is a
// different grant.
export const grantBody = (email: string, role: GrantedRole, areas: readonly string[] | undefined): AccessGrant => ({
    email,
    role,
    ...(areas === undefined || role === `maintainer` ? {} : { areas: [...areas] }),
});

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
