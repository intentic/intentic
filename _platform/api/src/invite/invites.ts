import type { InviteRecord } from "@intentic-app/api-contract";
import { GrantedRoleSchema } from "@intentic/sandbox-contract";

// How long an emailed invite link stays valid. Long enough for the invitee to get around to it; short enough
// that a stale link in an inbox goes dead. Resend mints a fresh token + expiry.
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// The invite/grant row's derived state, the only place the pending/accepted/expired rules live, so the roster
// and the accept gate agree. Pure (no DB): unit-tested in invites.test.ts.
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
    // Parsed rather than cast: the column is a bare string, and a row written by a build with a different
    // vocabulary must degrade to the safest tier instead of leaking an unknown word onto the wire.
    role: GrantedRoleSchema.catch(`viewer`).parse(member.role),
    status: inviteStatus(member, now),
    invitedAt: member.createdAt.toISOString(),
    expiresAt: member.inviteExpiresAt?.toISOString(),
});

// The accept gate for a found invite row: whether this caller can accept, and if so whether it's a fresh accept
// (needs the acceptedAt write) or already done (idempotent). email-locked, the caller's Google email must equal
// the invited address, since the daemon authorizes by that exact email. Pure so the expiry/lock rules are tested
// without a DB; the handler maps each rejection to an ORPCError and the null-row (invalid token) case itself.
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
