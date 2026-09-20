import type { GrantedRole } from "@intentic/sandbox-contract";

// What one grant sends the daemon, and the one way it can be malformed before it is sent. Pure, since the Access
// page's two writes (daemon first, platform second) both read it, and a desk with no card to wear is a sign-in the
// daemon refuses on the spot.

export interface AccessGrant {
    readonly email: string;
    readonly role: GrantedRole;
    // Persona ids, on a desk grant only.
    readonly desks?: readonly string[];
}

// The daemon's `/members` body: desks ride only on a desk, whatever the picker held when the tier changed.
export const grantBody = (email: string, role: GrantedRole, desks: readonly string[]): AccessGrant =>
    role === `desk` ? { email, role, desks: [...desks] } : { email, role };

// Whether the grant can be sent at all; the one refusal the form makes itself rather than reading off the daemon.
export const grantSendable = (role: GrantedRole, desks: readonly string[]): boolean => role !== `desk` || desks.length > 0;
