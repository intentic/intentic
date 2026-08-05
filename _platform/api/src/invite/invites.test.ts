import { describe, expect, it } from "vitest";
import { inviteAcceptDecision, inviteStatus, toInviteRecord } from "./invites.js";

const now = new Date(`2026-07-03T12:00:00Z`);
const future = new Date(`2026-07-10T12:00:00Z`);
const past = new Date(`2026-07-01T12:00:00Z`);

describe(`inviteStatus`, () => {
    it(`is accepted once acceptedAt is set, regardless of expiry`, () => {
        expect(inviteStatus({ acceptedAt: past, inviteExpiresAt: past }, now)).toBe(`accepted`);
    });
    it(`is expired when the link lapsed unaccepted`, () => {
        expect(inviteStatus({ acceptedAt: null, inviteExpiresAt: past }, now)).toBe(`expired`);
    });
    it(`is pending while unaccepted and unexpired`, () => {
        expect(inviteStatus({ acceptedAt: null, inviteExpiresAt: future }, now)).toBe(`pending`);
    });
});

describe(`inviteAcceptDecision`, () => {
    const member = { email: `invitee@example.com`, acceptedAt: null, inviteExpiresAt: future };

    it(`accepts a valid invite by the invited address (case-insensitive)`, () => {
        expect(inviteAcceptDecision(member, `Invitee@Example.com`, now)).toBe(`accept`);
    });
    it(`is idempotent once accepted`, () => {
        expect(inviteAcceptDecision({ ...member, acceptedAt: past }, `invitee@example.com`, now)).toBe(`already-accepted`);
    });
    it(`rejects an expired link before checking identity`, () => {
        expect(inviteAcceptDecision({ ...member, inviteExpiresAt: past }, `invitee@example.com`, now)).toBe(`expired`);
    });
    it(`locks to the invited email`, () => {
        expect(inviteAcceptDecision(member, `someone.else@example.com`, now)).toBe(`wrong-email`);
    });
});

describe(`toInviteRecord`, () => {
    it(`shapes the row for the wire, dropping expiry to undefined when absent`, () => {
        const record = toInviteRecord({ email: `a@b.com`, acceptedAt: past, inviteExpiresAt: null, createdAt: past }, now);
        expect(record).toEqual({ email: `a@b.com`, status: `accepted`, invitedAt: past.toISOString(), expiresAt: undefined });
    });
});
