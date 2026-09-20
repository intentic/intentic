import type { InviteRecord } from "@intentic/api-contract";
import type { GrantedRole } from "@intentic/sandbox-contract";

// THE SHARED ACCESS ROSTER: the Access tab reads two copies of who may reach this sandbox — the platform's record
// (tier, invite state) and the daemon's enforced grant (the one that knows which cards a desk holds) — and the tab
// only makes sense when the two agree. One store here, read by both seams (platform.ts, daemon.ts), is what keeps
// them agreeing through a grant, a re-grade and a revoke.

// The daemon's row: desks ride only on a desk, as the real store writes it (auth/auth.ts memberRow).
export interface DemoGrant {
    email: string;
    role: GrantedRole;
    desks?: string[];
}

interface DemoMember extends DemoGrant {
    status: InviteRecord["status"];
    invitedAt: string;
}

const ago = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString();

// Three states worth seeing at once: an accepted collaborator, a desk holding one card, and an invite still out.
const roster: DemoMember[] = [
    { email: `jo@acme.dev`, role: `collaborator`, status: `accepted`, invitedAt: ago(26) },
    { email: `sam@acme.dev`, role: `desk`, desks: [`maya-support`], status: `accepted`, invitedAt: ago(9) },
    { email: `rin@acme.dev`, role: `viewer`, status: `pending`, invitedAt: ago(1) },
];

const index = (email: string): number => roster.findIndex((member) => member.email === email.toLowerCase());

/** The platform's copy: tier and invite state, never the cards. */
export const inviteRecords = (): InviteRecord[] =>
    roster.map(({ email, role, status, invitedAt }) => ({ email, role, status, invitedAt }));

/** The daemon's copy: the enforced grant, with a desk's cards. */
export const grants = (): DemoGrant[] => roster.map(({ email, role, desks }) => (role === `desk` ? { email, role, desks: [...(desks ?? [])] } : { email, role }));

/** Upsert, as both stores do: granting an address that already holds access re-grades it and replaces its cards. */
export const grantAccess = (email: string, role: GrantedRole, desks: readonly string[] | undefined): void => {
    const address = email.toLowerCase();
    const at = index(address);
    const held = at === -1 ? undefined : roster[at];
    const row: DemoMember = {
        email: address,
        role,
        ...(role === `desk` ? { desks: [...(desks ?? [])] } : {}),
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
