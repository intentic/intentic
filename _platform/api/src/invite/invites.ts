import type { InviteRecord } from "@intentic/api-contract";
import { GrantedRoleSchema } from "@intentic/sandbox-contract";

// Long enough for the invitee to get to it; short enough that a stale link in an inbox goes dead.
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// The invite row's derived state; the only place pending/accepted/expired rules live, so roster and accept gate agree.
interface InviteRow {
    email: string;
    role: string;
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

export const toInviteRecord = (member: InviteRow, now: Date): InviteRecord => ({
    email: member.email,
    // Parsed rather than cast: a role this build does not know degrades to the safest tier, not onto the wire.
    role: GrantedRoleSchema.catch(`viewer`).parse(member.role),
    status: inviteStatus(member, now),
    invitedAt: member.createdAt.toISOString(),
    expiresAt: member.inviteExpiresAt?.toISOString(),
});

// Whether this caller can accept, and if a fresh accept or already done; email-locked to the invited address, since the
// daemon authorizes by that exact email.
export type InviteAcceptDecision = "accept" | "already-accepted" | "expired" | "wrong-email";

export const inviteAcceptDecision = (
    member: Pick<InviteRow, "email" | "acceptedAt" | "inviteExpiresAt">,
    userEmail: string,
    now: Date,
): InviteAcceptDecision => {
    if (member.acceptedAt) {
        return `already-accepted`;
    }
    if (member.inviteExpiresAt && member.inviteExpiresAt < now) {
        return `expired`;
    }
    if (userEmail.toLowerCase() !== member.email) {
        return `wrong-email`;
    }
    return `accept`;
};
