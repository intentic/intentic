import { describe, expect, test } from "vitest";
import { mergePasskey, type PasskeyCredential } from "./passkeys.js";

/* The store is a passkey's ONLY carrier between browsers, and Chromium will not take back a credential that has
 * lost its rpId ("The Relying Party ID is a required parameter"). So the one thing a write here must be
 * incapable of is subtraction: these pin that down field by field, because the failure it prevents is silent at
 * every layer above it, a 2FA prompt that rejects with no reason given. */
describe("mergePasskey", () => {
    const stored = {
        credentialId: "cred-1",
        isResidentCredential: false,
        rpId: "www.npmjs.com",
        privateKey: "key",
        userHandle: "handle",
        signCount: 5,
        userName: "owner",
    };

    test("a partial event keeps the fields the store already holds", () => {
        // Exactly the shape the npmjs record was found in: the required fields, none of the optional ones.
        const merged = mergePasskey(stored, { credentialId: "cred-1", isResidentCredential: false, privateKey: "key", signCount: 6 });
        expect(merged.rpId).toBe("www.npmjs.com");
        expect(merged.userHandle).toBe("handle");
        expect(merged.userName).toBe("owner");
        // What the event DID carry still wins: an assertion's bumped counter is the whole point of the write.
        expect(merged.signCount).toBe(6);
    });

    test("an explicit undefined does not erase a good field", () => {
        /* `exactOptionalPropertyTypes` forbids writing this in typed code, which is exactly why the cast stays:
         * the value under test comes off a CDP event, and the wire is not bound by our interface. Spreading
         * such a payload straight onto the stored record is the mistake this asserts against. */
        const wire = { ...stored, rpId: undefined, signCount: 7 } as unknown as PasskeyCredential;
        const merged = mergePasskey(stored, wire);
        expect(merged.rpId).toBe("www.npmjs.com");
        expect(merged.signCount).toBe(7);
    });

    test("a first enrollment is stored as it arrives", () => {
        const fresh = { credentialId: "cred-2", isResidentCredential: true, rpId: "google.com", privateKey: "k", signCount: 1 };
        expect(mergePasskey(undefined, fresh)).toEqual(fresh);
    });

    test("a rotated key replaces the old one rather than merging into a chimera", () => {
        const merged = mergePasskey(stored, { ...stored, privateKey: "rotated", signCount: 1 });
        expect(merged.privateKey).toBe("rotated");
    });
});
