import type { InviteRecord } from "@intentic/api-contract";
import type { CredentialReach, GrantedRole, SecretInventoryEntry } from "@intentic/sandbox-contract";
import { demoQuiet } from "../mode";

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
    // What their assistants may spend; absent is every connected account and secret, as on the real roster.
    credentials?: CredentialReach;
}

interface DemoMember extends DemoGrant {
    status: InviteRecord["status"];
    invitedAt: string;
}

const ago = (days: number): string => new Date(Date.now() - days * 86_400_000).toISOString();

// Three states worth seeing at once: an accepted collaborator, a guest fenced to the one area Maya works in, and an
// invite still out. A quiet recording (mode.ts `demoQuiet`) is the ordinary team without the fenced guest, whose row
// carries a fence, an area chip and the persona she talks to: a teammate and an invite are the whole of what sharing is.
// Jo's assistants are held to the code host and the error tracker: the row says so in its line, and the dialog opens on
// those two ticked.
const roster: DemoMember[] = [
    {
        email: `jo@acme.dev`,
        role: `collaborator`,
        credentials: { capabilities: [`github`, `sentry`], secrets: [`SENTRY_DSN`] },
        status: `accepted`,
        invitedAt: ago(26),
    },
    ...(demoQuiet() ? [] : [{ email: `sam@acme.dev`, role: `guest` as const, areas: [`support`], status: `accepted` as const, invitedAt: ago(9) }]),
    { email: `rin@acme.dev`, role: `viewer`, status: `pending`, invitedAt: ago(1) },
];

const index = (email: string): number => roster.findIndex((member) => member.email === email.toLowerCase());

/** The platform's copy: tier and invite state, never the fence. */
export const inviteRecords = (): InviteRecord[] =>
    roster.map(({ email, role, status, invitedAt }) => ({ email, role, status, invitedAt }));

/** The daemon's copy: the enforced grant, with the areas it is fenced to. */
export const grants = (): DemoGrant[] =>
    roster.map(({ email, role, areas, credentials }) => ({
        email,
        role,
        ...(areas === undefined ? {} : { areas: [...areas] }),
        ...(credentials === undefined ? {} : { credentials }),
    }));

/** Upsert, as both stores do: granting an address that already holds access re-grades it and replaces its fence. A
 *  grant silent about the reach keeps the row's, `all` lifts it, and a maintainer holds none (auth.ts memberRow). */
export const grantAccess = (email: string, role: GrantedRole, areas: readonly string[] | undefined, credentials?: CredentialReach | `all`): void => {
    const address = email.toLowerCase();
    const at = index(address);
    const held = at === -1 ? undefined : roster[at];
    const reach = role === `maintainer` || credentials === `all` ? undefined : (credentials ?? held?.credentials);
    const row: DemoMember = {
        email: address,
        role,
        status: held?.status ?? `pending`,
        invitedAt: held?.invitedAt ?? new Date().toISOString(),
    };
    if (areas !== undefined) {
        row.areas = [...areas];
    }
    if (reach !== undefined) {
        row.credentials = reach;
    }
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

/** The secrets inventory: the connections' own credentials, three values the owner keeps and one the sandbox made, so
 *  the Secrets page and the person dialog's reach both read as a working sandbox's. */
export const demoSecretInventory = (): SecretInventoryEntry[] => [
    ...[`github`, `postgres`, `sentry`, `discord`, `stripe`].map((key) => ({
        key,
        kind: `capability` as const,
        status: `connected` as const,
        requiredBy: [],
        storedAt: `the capability vault`,
        revealable: true,
    })),
    ...[`DATABASE_URL`, `SENTRY_DSN`, `STRIPE_WEBHOOK_SECRET`].map((key) => ({
        key,
        kind: `env` as const,
        status: `set` as const,
        requiredBy: [],
        storedAt: `the sandbox's own store`,
        revealable: true,
    })),
    { key: `SESSION_SECRET`, kind: `generated`, status: `set`, requiredBy: [], storedAt: `generated by the sandbox`, revealable: true },
];
