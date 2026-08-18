import type { SandboxSummary } from "@intentic-app/api-contract";
import type { GrantedRole } from "@intentic/sandbox-contract";
import { computed, ref } from "vue";
import { removeStoredValue, storedValue, storeValue } from "../browserStorage";

/* A GUEST — somebody who reached a sandbox through a join link instead of through a platform account.
 *
 * The invite flow makes a person sign up, land in the registry, and read the sandbox's address out of it. A
 * join link skips all three: the link names the box, the box's own /join admits the person who signs in with
 * Google, and from that moment the browser talks to the box exactly as an owner's browser does — the daemon
 * was always the enforcer (it verifies the Google identity, holds the members list, and applies the role
 * floors), so nothing about the working session needs the platform at all.
 *
 * WHICH LEAVES THIS MODULE ONE JOB: standing in for the registry. The app learns where a sandbox lives by
 * reading the platform's list, and a guest has no list to read — so their one box is remembered here, in this
 * browser, and useSandbox serves it from here instead of from the network. That is the whole of guest mode;
 * every other seam (the daemon session, the endpoint choice, the role gates) is untouched and unaware.
 *
 * Kept in localStorage rather than in memory so a reload — or the tab the link was opened in being closed and
 * reopened — does not need the link again. Nothing secret lives here: the link's secret is spent at redemption
 * and never stored, and the credential that follows is the daemon session sandboxSession.ts already owns.
 */

export interface GuestAccess {
    // The box's public address, from the link. What every daemon call is appended to.
    readonly daemonUrl: string;
    // What the link granted, as the daemon recorded it. A rendering fact only — the box re-checks every call.
    readonly role: GrantedRole;
    // The Google identity that redeemed the link, so the shell can say who this browser is signed in as.
    readonly email: string;
    // When this browser joined, in ISO. Doubles as the "seen" stamp of the summary below (see there).
    readonly joinedAt: string;
    // The box's own name for itself when it gave one, else its hostname — a guest has no registry to ask.
    readonly name: string;
}

const STORAGE_KEY = `intentic.guest`;

const read = (): GuestAccess | undefined => {
    const raw = storedValue(STORAGE_KEY);
    if (raw === undefined) {
        return undefined;
    }
    try {
        const parsed = JSON.parse(raw) as Partial<GuestAccess>;
        return typeof parsed.daemonUrl === `string` && typeof parsed.email === `string` && typeof parsed.role === `string`
            ? {
                  daemonUrl: parsed.daemonUrl,
                  role: parsed.role as GrantedRole,
                  email: parsed.email,
                  joinedAt: parsed.joinedAt ?? new Date().toISOString(),
                  name: parsed.name ?? new URL(parsed.daemonUrl).hostname,
              }
            : undefined;
    } catch {
        return undefined;
    }
};

const access = ref<GuestAccess | undefined>(read());

/* Is this browser here as a guest? Read by the router (which must not send a guest to the platform's sign-in)
 * and by useSandbox (which must not ask the platform for a list nobody has). A function as well as a ref
 * because the router guard runs outside a reactive context. */
export const isGuest = (): boolean => access.value !== undefined;
export const guestAccess = computed<GuestAccess | undefined>(() => access.value);

/* The sandbox id a guest's box is filed under. Derived from the address so it is stable across reloads and
 * distinct per box — the daemon session store, the active-sandbox memory and the per-sandbox query keys are
 * all keyed by it, and a value that changed between visits would silently orphan every one of them. */
export const guestSandboxId = (daemonUrl: string): string => `guest:${new URL(daemonUrl).hostname}`;

export const setGuestAccess = (next: GuestAccess): void => {
    access.value = next;
    storeValue(STORAGE_KEY, JSON.stringify(next));
};

// Leaving: forget the box. The membership itself is the owner's to remove — this only ends the visit in this
// browser, which is why it is worded as leaving rather than as revoking anything.
export const clearGuestAccess = (): void => {
    access.value = undefined;
    removeStoredValue(STORAGE_KEY);
};

/* The guest's box, in the shape the registry would have returned for it. Everything the platform would know
 * and a guest cannot is null — no image, no setup report, no boot report, no cloud or hosted record — and the
 * two fields that are NOT null carry real facts: the address the link named, and the role the box granted.
 *
 * `token` is empty on purpose. It is the connect token, which only an owner holds; the endpoint chooser reads
 * it to derive the loopback port and already treats an empty one as "no local shortcut exists", so a guest
 * simply always reaches the box the way the link did.
 *
 * `lastSeenAt` is the join stamp rather than null because the setup gate reads exactly that field to decide
 * whether a workspace is ready to open — and for a guest it is true by construction: they are only here
 * because the box answered them a moment ago. */
export const guestSandboxes = (): SandboxSummary[] => {
    const guest = access.value;
    if (guest === undefined) {
        return [];
    }
    return [
        {
            id: guestSandboxId(guest.daemonUrl),
            name: guest.name,
            image: null,
            daemonUrl: guest.daemonUrl,
            lastSeenAt: guest.joinedAt,
            setupCodeClaimedAt: null,
            setupReport: null,
            bootReport: null,
            announceRefusal: null,
            token: ``,
            role: guest.role,
            providedTunnel: false,
            cloud: null,
            hosted: null,
        },
    ];
};
