import type { InviteRecord } from "@intentic/api-contract";
import { type ManageRight, ManageRightSchema } from "@intentic/sandbox-contract/schemas/members";
import { type GrantedRole, GrantedRoleSchema } from "@intentic/sandbox-contract/schemas/shared";

// Long enough for the invitee to get to it; short enough that a stale link in an inbox goes dead.
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// The invite row's derived state; the only place pending/accepted/expired rules live, so roster and accept gate agree.
interface InviteRow {
    email: string;
    role: string;
    manages: string[];
    acceptedAt: Date | null;
    inviteExpiresAt: Date | null;
    createdAt: Date;
}

export const inviteStatus = (member: Pick<InviteRow, "acceptedAt" | "inviteExpiresAt">, now: Date): InviteRecord["status"] => {
    if (member.acceptedAt) {
        return `accepted`;
    }
    if (member.inviteExpiresAt && member.inviteExpiresAt < now) {
        return `expired`;
    }
    return `pending`;
};

// A row's grant as the wire and `peopleChangeRefusal` read it. Parsed rather than cast: a role this build does not know
// degrades to the safest tier, and a right it does not know is dropped, so neither reaches the wire or widens a check.
export const storedGrant = (member: Pick<InviteRow, "role" | "manages">) => ({
    role: GrantedRoleSchema.catch(`viewer`).parse(member.role),
    manages: member.manages.flatMap((right) => {
        const parsed = ManageRightSchema.safeParse(right);
        return parsed.success ? [parsed.data] : [];
    }),
});

// The rights a grant leaves on the row, by the daemon's rule (member-row.ts `managesOfRow`): never on Full access, who runs
// every part, and never on a guest, who sees none of it. Kept off here too, so the mirror never lets a guest manage invites.
export const rightsOnRow = (role: GrantedRole, manages: readonly ManageRight[]): ManageRight[] =>
    role === `maintainer` || role === `guest` ? [] : [...new Set(manages)];

export const toInviteRecord = (member: InviteRow, now: Date): InviteRecord => {
    const { role, manages } = storedGrant(member);
    return {
        email: member.email,
        role,
        // Absent is none, as the daemon's row reads it.
        ...(manages.length > 0 && { manages }),
        status: inviteStatus(member, now),
        invitedAt: member.createdAt.toISOString(),
        expiresAt: member.inviteExpiresAt?.toISOString(),
    };
};

// Whether this caller can accept, and if a fresh accept or already done; email-locked to the invited address, since the
// daemon authorizes by that exact email.
export type InviteAcceptDecision = "accept" | "already-accepted" | "expired" | "wrong-email";

export const inviteAcceptDecision = (
    member: Pick<InviteRow, "email" | "acceptedAt" | "inviteExpiresAt">,
    userEmail: string,
    now: Date,
): InviteAcceptDecision => {
    if (userEmail.toLowerCase() !== member.email) {
        return `wrong-email`;
    }
    if (member.acceptedAt) {
        return `already-accepted`;
    }
    if (member.inviteExpiresAt && member.inviteExpiresAt < now) {
        return `expired`;
    }
    return `accept`;
};
