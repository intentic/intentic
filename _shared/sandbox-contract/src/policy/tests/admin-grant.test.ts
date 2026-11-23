import { ADMIN_GRANT_TTL_MS, adminGrantHolds, commandSha256, signAdminGrant } from "../admin/admin-grant.js";
import { newSignKeyPair } from "../keyring-seal.js";

// The bytes intentic-remoted's service verifies (src/service/admin.rs holds the same vector): a grant from this signer
// must read there, and one from a fixed key must read here exactly as it reads there.

const VECTOR = {
    publicKey: "6kpsY-KcUgq-9VB7Ey7F-ZVHdq6-vnuSQh7qaRRG0iw",
    privateKey: "BwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwcHBwc",
    command: "Get-Service Spooler | Format-List *",
    signed: {
        payload:
            "eyJraW5kIjoiYWRtaW4tcnVuIiwiY29tbWFuZFNoYTI1NiI6ImYxOGFkOWRjYjAyZmNjZjAxNjZiZWVhNTlhYmQ5ZTMyNTQxZTgyY2IyNTY3Y2QwMzk1OWJkYTgwOGIxNGQ3YmUiLCJub25jZSI6IkFBRUNBd1FGQmdjSUNRb0xEQTBPRHciLCJpc3N1ZWRBdCI6MTc5NTQwMDAwMDAwMCwiZXhwaXJlc0F0IjoxNzk1NDAwMzAwMDAwfQ",
        sig: "iAcYj9YGvrU8kmaA5a3oStMqlGb31HSVKboBDqD2aXLnl2SFhucx8K4mI_1N3JTZjmntUy3kmDWSNorKoz82CQ",
    },
};

test("the signer makes, byte for byte, the vector the service is tested against", () => {
    expect(commandSha256(VECTOR.command)).toBe("f18ad9dcb02fccf0166beea59abd9e32541e82cb2567cd03959bda808b14d7be");
    expect(signAdminGrant(VECTOR, VECTOR.command, "AAECAwQFBgcICQoLDA0ODw", 1_795_400_000_000)).toEqual(VECTOR.signed);
    expect(adminGrantHolds(VECTOR.publicKey, VECTOR.signed, VECTOR.command, 1_795_400_100_000)).toBe(true);
});

test("a grant holds for its own command, under its own key, until it expires", () => {
    const pair = newSignKeyPair();
    const signed = signAdminGrant(pair, "diskpart /s compact.txt", "AAECAwQFBgcICQoLDA0ODw", 1000);
    expect(adminGrantHolds(pair.publicKey, signed, "diskpart /s compact.txt", 2000)).toBe(true);
    expect(adminGrantHolds(pair.publicKey, signed, "diskpart /s other.txt", 2000)).toBe(false);
    expect(adminGrantHolds(newSignKeyPair().publicKey, signed, "diskpart /s compact.txt", 2000)).toBe(false);
    expect(adminGrantHolds(pair.publicKey, signed, "diskpart /s compact.txt", 1000 + ADMIN_GRANT_TTL_MS + 1)).toBe(false);
});

test("no grant lives longer than five minutes", () => {
    expect(() => signAdminGrant(newSignKeyPair(), "x", "AAECAwQFBgcICQoLDA0ODw", 0, ADMIN_GRANT_TTL_MS + 1)).toThrow(/at most 300 s/);
});
