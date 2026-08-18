// @vitest-environment jsdom
// Needs a browser's storage: the point of this module is that a visit survives a reload, which cannot be
// asserted against a node global that has no localStorage at all.
import { beforeEach, describe, expect, it } from "vitest";
import { clearGuestAccess, guestSandboxes, guestSandboxId, isGuest, setGuestAccess } from "./guestAccess";

/* Guest mode's whole surface: remembering one box, and describing it in the shape the rest of the app already
 * reads. The properties worth pinning are the ones other modules silently depend on — an id that survives a
 * reload, an empty connect token (which is what tells the endpoint chooser there is no local shortcut), and a
 * `lastSeenAt` the setup gate accepts, without which a guest would be bounced to a setup screen they have no
 * business seeing. */

const GUEST = {
    daemonUrl: `https://sandbox-abc123.sbx.example.dev`,
    role: `collaborator`,
    email: `ada@example.com`,
    joinedAt: `2026-08-18T10:00:00.000Z`,
    name: `sandbox-abc123`,
} as const;

beforeEach(() => {
    clearGuestAccess();
});

describe("remembering the visit", () => {
    it("is not a guest until a link is redeemed, and is again once they leave", () => {
        expect(isGuest()).toBe(false);

        setGuestAccess(GUEST);
        expect(isGuest()).toBe(true);

        clearGuestAccess();
        expect(isGuest()).toBe(false);
        expect(guestSandboxes()).toEqual([]);
    });

    it("survives a reload — the record is read back from storage, not held in memory", () => {
        setGuestAccess(GUEST);

        // What a fresh page load does: the module reads storage as it initializes.
        expect(JSON.parse(localStorage.getItem(`intentic.guest`) ?? `{}`)).toMatchObject({ daemonUrl: GUEST.daemonUrl, email: GUEST.email });
    });
});

describe("the box, in the shape the app reads", () => {
    it("keeps one id per address, so sessions and per-sandbox caches are not orphaned between visits", () => {
        expect(guestSandboxId(GUEST.daemonUrl)).toBe(guestSandboxId(`${GUEST.daemonUrl}/`));
        expect(guestSandboxId(GUEST.daemonUrl)).not.toBe(guestSandboxId(`https://sandbox-other.sbx.example.dev`));
    });

    it("carries the address and role, and an EMPTY connect token — a guest has no local shortcut to derive", () => {
        setGuestAccess(GUEST);

        const [box] = guestSandboxes();

        expect(box).toMatchObject({ daemonUrl: GUEST.daemonUrl, role: `collaborator`, token: `` });
    });

    it("reports having been seen, which is what the setup gate reads to let the workspace open", () => {
        setGuestAccess(GUEST);

        // Mirrors router/setupGate.ts: a null here would redirect the guest to /setup instead.
        expect(guestSandboxes().some((box) => box.lastSeenAt !== null)).toBe(true);
    });

    it("claims none of the platform's knowledge — no image, no reports, no cloud or hosted record", () => {
        setGuestAccess(GUEST);

        const [box] = guestSandboxes();

        expect(box).toMatchObject({ image: null, setupReport: null, bootReport: null, cloud: null, hosted: null, providedTunnel: false });
    });
});
