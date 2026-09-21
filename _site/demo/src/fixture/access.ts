import type { InviteRecord } from "@intentic/api-contract";
import type { GrantedRole } from "@intentic/sandbox-contract";

// THE SHARED ACCESS ROSTER: the Access tab reads two copies of who may reach this sandbox — the platform's record
// (tier, invite state) and the daemon's enforced grant (the one that knows the fence) — and the tab only makes sense
// when the two agree. One store here, read by both seams (platform.ts, daemon.ts), is what keeps them agreeing
// through a grant, a re-grade and a revoke.

// The daemon's row: an area list only where it was granted, as the real store writes it (auth/auth.ts memberRow).
// Absent areas are the whole workspace, which is what an unnarrowed grant means — and with it every assistant, since
// which cards a person may wear is read off this fence rather than listed per person.
export interface DemoGrant {
    email: string;
    role: GrantedRole;
    areas?: string[];
}

interface DemoMember extends DemoGrant {
    status: InviteRecord["status"];
    invitedAt: string;
}

const ago = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString();

// Three states worth seeing at once: an accepted collaborator, a desk fenced to the one area Maya works in, and an
// invite still out.
const roster: DemoMember[] = [
    { email: `jo@acme.dev`, role: `collaborator`, status: `accepted`, invitedAt: ago(26) },
    { email: `sam@acme.dev`, role: `desk`, areas: [`support`], status: `accepted`, invitedAt: ago(9) },
    { email: `rin@acme.dev`, role: `viewer`, status: `pending`, invitedAt: ago(1) },
];

const index = (email: string): number => roster.findIndex((member) => member.email === email.toLowerCase());

/** The platform's copy: tier and invite state, never the fence. */
export const inviteRecords = (): InviteRecord[] =>
    roster.map(({ email, role, status, invitedAt }) => ({ email, role, status, invitedAt }));

/** The daemon's copy: the enforced grant, with the areas it is fenced to. */
export const grants = (): DemoGrant[] =>
    roster.map(({ email, role, areas }) => ({
        email,
        role,
        ...(areas === undefined ? {} : { areas: [...areas] }),
    }));

/** Upsert, as both stores do: granting an address that already holds access re-grades it and replaces its fence. */
export const grantAccess = (email: string, role: GrantedRole, areas: readonly string[] | undefined): void => {
    const address = email.toLowerCase();
    const at = index(address);
    const held = at === -1 ? undefined : roster[at];
    const row: DemoMember = {
        email: address,
        role,
        ...(areas === undefined ? {} : { areas: [...areas] }),
        status: held?.status ?? `pending`,
        invitedAt: held?.invitedAt ?? new Date().toISOString(),
    };
    if (at === -1) {
        roster.push(row);
    } else {
        roster[at] = row;
    }
};

export const revokeAccess = (email: string): void => {
    const at = index(email);
    if (at !== -1) {
        roster.splice(at, 1);
    }
};
