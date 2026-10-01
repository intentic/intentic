import type { SandboxSummary } from "@intentic/api-contract";
import { queryClient } from "../../../lib/queryPersistence";
import { idTokenClaims } from "../../auth/googleToken";
import { useAuth } from "../../auth/useAuth";
import { SANDBOX_LIST_KEY, useSandbox } from "../client/useSandbox";
import type { RememberedAccount, RememberedSandbox } from "./deviceDirectory";

// OPENING A SANDBOX WITHOUT THE PLATFORM (README.md). All the workspace needs from the platform once it is open is the
// account and the list: the account is the one this device last saw list, whole, and the list is what it remembers.
// The daemon checks the reader's Google sign-in itself, which needs no platform either. Seeding the list's cache entry is
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

// A device that remembers no account (the platform was down before this one ever listed) is named by the Google
// sign-in the daemon checks anyway; undefined for a token that is not one.
export const accountFromGoogle = (idToken: string, now = new Date()): RememberedAccount | undefined => {
    const claims = idTokenClaims(idToken);
    if (claims === undefined) {
        return undefined;
    }
    return { user: { id: `direct:${claims.email}`, email: claims.email, name: claims.email, image: null }, savedAt: now.toISOString(), sandboxes: [] };
};

// A sandbox known only by its address: named after its host until the platform names it again. Owner by default, a
// rendering fact only; the daemon decides what the reader may do.
export const sandboxAt = (daemonUrl: string): RememberedSandbox => {
    const host = new URL(daemonUrl).hostname;
    return { id: `direct:${host}`, name: host, image: null, daemonUrl, role: `owner`, hosted: false, lastSeenAt: null };
};
