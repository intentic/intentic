import type { SandboxSummary, User } from "@intentic/api-contract";
import { queryClient } from "../../../lib/queryPersistence";
import { idTokenClaims } from "../../../client/auth/googleToken";
import { useAuth } from "../../../client/auth/useAuth";
import { SANDBOX_LIST_KEY, useSandbox } from "../../../client/sandbox/useSandbox";
import type { RememberedAccount, RememberedSandbox } from "../../../client/directory/deviceDirectory";
import { directMode } from "../../../client/directory/directState";
import { platformHealth } from "../../../lib/platform/platformHealth";

// OPENING A SANDBOX WITHOUT THE PLATFORM (README.md). All the workspace needs from the platform once it is open is the
// account and the list: the account is the one this device last saw list, whole, and the list is what it remembers.
// The daemon checks the reader's sign-in itself (Google's, a passkey, or a session it minted), which needs no platform. Seeding the list's cache entry is
// all it takes, since every reader of the list reads that entry (useSandbox.ts); what else would ask the platform
// (sharing, billing, a hosted machine's power) fails as it does offline, and the direct-mode card says why
// (notificationSources.ts). The next session check the platform answers ends it.

// Whether the window still waits for the platform's own list after opening without it: set by every way in, cleared
// once a list the platform answered replaces the remembered one, or a sign-out ends the window's account.
// allow(module-state): one window waits for one list
let listOwed = false;

// A remembered sandbox as a list row: no token (none is remembered; only a first bind spends one), no hosted record (its
// machine is the platform's to drive), nothing reported. Its certified loopback name rides along where it was remembered,
// and endpoint selection finds its loopback id in the memory by the row's id (useEndpoint.ts), so a sandbox on this very
// computer is tried here before its tunnel, as it would be with the platform up. A last-seen time it never had is the epoch, since a row without
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
    localHostname: entry.localHostname ?? null,
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
    listOwed = true;
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

// WITHOUT ASKING (2026-11-09). A device that remembers the account no longer stops at the outage screen when the session
// check cannot be answered: it opens the workspace as that account, on what it remembers, at once, and the rail's offline
// tile is all that says so (shell/rail/tools/RailSignals.vue). The screen stays for a device that remembers
// nothing, and for an address (`/open?url=`) naming a sandbox this device does not remember, which only it can offer.

// What an automatic entry is asked to open: the sandbox an address names (its normalized address), or the one this window
// had open.
export interface MemoryChoice {
    readonly activeId?: string;
    readonly daemonUrl?: string;
}

// The remembered sandbox an automatic entry opens: the one an address names, else the one this window had open, else
// the first still listed that has checked in, else the first.
export const pickRemembered = (account: RememberedAccount, choice: MemoryChoice): RememberedSandbox | undefined => {
    if (choice.daemonUrl !== undefined) {
        return account.sandboxes.find((entry) => entry.daemonUrl === choice.daemonUrl);
    }
    const open = account.sandboxes.find((entry) => entry.id === choice.activeId);
    const listed = account.sandboxes.filter((entry) => entry.missingSince === undefined);
    const pool = listed.length > 0 ? listed : account.sandboxes;
    return open ?? pool.find((entry) => entry.lastSeenAt !== null) ?? pool[0];
};

// Opens the window as the remembered account when the platform could not be asked; the account it opened as, or
// undefined where nothing remembered fits (the caller shows the outage screen then). `daemonUrl` is the sandbox an
// address names, normalized.
export const enterFromMemory = (account: RememberedAccount | undefined, choice: MemoryChoice): User | undefined => {
    if (account === undefined) {
        return undefined;
    }
    const sandbox = pickRemembered(account, choice);
    if (sandbox === undefined) {
        return undefined;
    }
    enterDirectMode(account, sandbox);
    // The way back is the health reading turning up again, which only a down reading probes for: whatever sent the window
    // here (a refusal, a page that was not the platform's), it asks from now on until the platform answers.
    platformHealth.noteUnreachable();
    return useAuth().user.value ?? undefined;
};

// THE QUIET WAY BACK. The platform answering again (lib/platform/platformHealth.ts) ends a window opened without it
// the way a session check always has: the session it answers takes the window back, and the list it answers replaces
// the remembered one, with nothing for the reader to press. A session it no longer has signs the window out as before.
//
// The session answering ends direct mode by itself (useAuth.ts), before the list is asked; the list stays owed until the
// platform gives it, so a list that fails right after a session that answered is asked again at the next recovery,
// rather than leaving the window on the remembered, token-less rows (code review, 2026-11-09).
platformHealth.onRecovered(() => {
    if (!directMode.value && !listOwed) {
        return;
    }
    void (async () => {
        try {
            if (directMode.value && (await useAuth().refresh()) === null) {
                listOwed = false;
                return;
            }
            await useSandbox().refresh();
            listOwed = false;
        } catch (error) {
            // Still not answering after all: the reading turns down again and the next recovery tries again.
            console.warn(`[direct] the platform answered, but not with the session and the list:`, error);
        }
    })();
});
