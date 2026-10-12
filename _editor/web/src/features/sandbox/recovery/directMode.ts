import type { SandboxSummary } from "@intentic/api-contract";
import { queryClient } from "../../../lib/queryPersistence";
import { idTokenClaims } from "../../../client/auth/googleToken";
import { useAuth } from "../../../client/auth/useAuth";
import { SANDBOX_LIST_KEY, useSandbox } from "../../../client/sandbox/useSandbox";
import type { RememberedAccount, RememberedSandbox } from "../../../client/directory/deviceDirectory";

// OPENING A SANDBOX WITHOUT THE PLATFORM (README.md). All the workspace needs from the platform once it is open is the
// account and the list: the account is the one this device last saw list, whole, and the list is what it remembers.
// The daemon checks the reader's sign-in itself (Google's, a passkey, or a session it minted), which needs no platform. Seeding the list's cache entry is
// all it takes, since every reader of the list reads that entry (useSandbox.ts); what else would ask the platform
// (sharing, billing, a hosted machine's power) fails as it does offline, and the direct-mode card says why
// (notificationSources.ts). The next session check the platform answers ends it.

// A remembered sandbox as a list row: no token (none is remembered; only a first bind spends one), no hosted record (its
// machine is the platform's to drive), nothing reported. A last-seen time it never had is the epoch, since a row without
// one reads as a setup still to finish (router/setupGate.ts).
export const summaryOf = (entry: RememberedSandbox): SandboxSummary => ({
    id: entry.id,
    name: entry.name,
    image: entry.image,
    daemonUrl: entry.daemonUrl,
    lastSeenAt: entry.lastSeenAt ?? new Date(0).toISOString(),
    setupCodeClaimedAt: null,
    setupReport: null,
    bootReport: null,
    announceRefusal: null,
    removedAt: null,
    removedBy: null,
    token: null,
    role: entry.role,
    providedAddress: false,
    localHostname: null,
    hosted: null,
});

// Opens the window on one remembered sandbox, as the account that remembers it. The account goes first, so the list it
// seeds is never remembered back as if the platform had answered it (rememberSandboxes.ts).
export const enterDirectMode = (account: RememberedAccount, sandbox: RememberedSandbox): void => {
    const rows = account.sandboxes.map(summaryOf);
    // A sandbox opened by its address alone (the /open link) joins this window's list.
    if (!rows.some((row) => row.id === sandbox.id)) {
        rows.push(summaryOf(sandbox));
    }
    useAuth().enterDirect(account.user);
    queryClient.setQueryData(SANDBOX_LIST_KEY, rows);
    useSandbox().select(sandbox.id);
};

// What names the reader on a device that remembers no account (the platform was down before this one ever listed):
// the Google sign-in the daemon checks anyway, or a daemon session, one this browser already holds on the sandbox or
// the one a passkey just opened. An account that signs in by email has no Google sign-in to offer, and the daemon's own
// session says who it let in just as well.
export type DirectProof = { readonly kind: `google`; readonly idToken: string } | { readonly kind: `session`; readonly email: string };

// The account a proof names, whole enough for the window to run as it; undefined for a token that is not one.
export const accountFromProof = (proof: DirectProof, now = new Date()): RememberedAccount | undefined => {
    const email = (proof.kind === `google` ? idTokenClaims(proof.idToken)?.email : proof.email)?.trim();
    if (email === undefined || email === ``) {
        return undefined;
    }
    return { user: { id: `direct:${email}`, email, name: email, image: null }, savedAt: now.toISOString(), sandboxes: [] };
};

// A sandbox known only by its address: named after its host until the platform names it again. Owner by default, a
// rendering fact only; the daemon decides what the reader may do.
export const sandboxAt = (daemonUrl: string): RememberedSandbox => {
    const host = new URL(daemonUrl).hostname;
    return { id: `direct:${host}`, name: host, image: null, daemonUrl, role: `owner`, hosted: false, lastSeenAt: null };
};
