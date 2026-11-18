import type { InviteRecord } from "@intentic/api-contract";
import { type ManageRight, ManageRightSchema } from "@intentic/sandbox-contract/schemas/members";
import { type GrantedTier, GrantedTierSchema } from "@intentic/sandbox-contract/schemas/shared";

// Long enough for the invitee to get to it; short enough that a stale link in an inbox goes dead.
export const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

// The invite row's derived state; the only place pending/accepted/expired rules live, so roster and accept gate agree.
interface InviteRow {
    email: string;
    tier: string;
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

// A row's grant as the wire and `peopleChangeRefusal` read it. Parsed rather than cast: a tier this build does not know
// degrades to the safest one, and a right it does not know is dropped, so neither reaches the wire or widens a check.
export const storedGrant = (member: Pick<InviteRow, "tier" | "manages">) => ({
    tier: GrantedTierSchema.catch(`viewer`).parse(member.tier),
    manages: member.manages.flatMap((right) => {
        const parsed = ManageRightSchema.safeParse(right);
        return parsed.success ? [parsed.data] : [];
    }),
});

// The rights a grant leaves on the row, by the daemon's rule (member-row.ts `managesOfRow`): never on Full access, who runs
// every part, and never on a guest, who sees none of it. Kept off here too, so the mirror never lets a guest manage invites.
export const rightsOnRow = (tier: GrantedTier, manages: readonly ManageRight[]): ManageRight[] =>
    tier === `maintainer` || tier === `guest` ? [] : [...new Set(manages)];

export const toInviteRecord = (member: InviteRow, now: Date): InviteRecord => {
    const { tier, manages } = storedGrant(member);
    return {
        email: member.email,
        tier,
        // Beside `tier` for one release (2026-11-18), for an editor from before the rename.
        role: tier,
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
