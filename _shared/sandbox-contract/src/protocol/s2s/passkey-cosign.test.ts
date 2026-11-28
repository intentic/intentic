import { sha256 } from "@noble/hashes/sha2.js";
import { canonicalBytes, fromBase64Url, toBase64Url } from "./canonical.js";
import { cosignChallenge, cosignChallengeBytes, type PasskeyCosign, PasskeyCosignSchema, verifyPasskeyCosign } from "./passkey-cosign.js";
import { softCosign, softPasskey } from "./passkey-cosign.testing.js";

const DIGEST = "a".repeat(64);
const CHALLENGE = { v: 1 as const, sandbox: "sbx-1", item: "book-flight", digest: DIGEST };
const EXPECTED = { sandbox: "sbx-1", digest: DIGEST, item: "book-flight" };

describe("the co-signature's challenge", () => {
    it("is SHA-256 over the canonical JSON of the challenge and the purpose, and nothing else", () => {
        const bytes = cosignChallengeBytes(CHALLENGE);
        expect(bytes).toEqual(sha256(canonicalBytes({ digest: DIGEST, item: "book-flight", purpose: "intentic-approval/1", sandbox: "sbx-1", v: 1 })));
        expect(new TextDecoder().decode(canonicalBytes({ ...CHALLENGE, purpose: "intentic-approval/1" }))).toBe(
            `{"digest":"${DIGEST}","item":"book-flight","purpose":"intentic-approval/1","sandbox":"sbx-1","v":1}`,
        );
        expect(cosignChallenge(CHALLENGE)).toBe(toBase64Url(bytes));
        expect(bytes).toHaveLength(32);
    });

    it("moves with every field, so no two approvals share one", () => {
        const others = [{ sandbox: "sbx-2" }, { item: "book-hotel" }, { digest: "b".repeat(64) }].map((change) => cosignChallenge({ ...CHALLENGE, ...change }));
        expect(new Set([cosignChallenge(CHALLENGE), ...others]).size).toBe(4);
    });
});

describe("verifyPasskeyCosign", () => {
    test.each([
        ["ES256", -7],
        ["EdDSA", -8],
        ["RS256", -257],
    ] as const)("accepts a %s passkey's assertion over the approval it names", async (_name, alg) => {
        const cosign = softCosign(softPasskey(alg), CHALLENGE);
        expect(PasskeyCosignSchema.parse(cosign)).toEqual(cosign);
        expect(await verifyPasskeyCosign(cosign, EXPECTED)).toEqual({ ok: true });
        // The item is the caller's to pin or leave open.
        expect(await verifyPasskeyCosign(cosign, { sandbox: "sbx-1", digest: DIGEST })).toEqual({ ok: true });
    });

    test("refuses an approval of another sandbox, item or digest than the one expected", async () => {
        const cosign = softCosign(softPasskey(), CHALLENGE);
        const another = { ok: false, reason: "it approved another sandbox, item or digest" };
        expect(await verifyPasskeyCosign(cosign, { ...EXPECTED, digest: "b".repeat(64) })).toEqual(another);
        expect(await verifyPasskeyCosign(cosign, { ...EXPECTED, sandbox: "sbx-2" })).toEqual(another);
        expect(await verifyPasskeyCosign(cosign, { ...EXPECTED, item: "book-hotel" })).toEqual(another);
    });

    test("refuses a challenge whose digest was changed after the passkey signed", async () => {
        const cosign = softCosign(softPasskey(), CHALLENGE);
        const tampered: PasskeyCosign = { ...cosign, challenge: { ...CHALLENGE, digest: "b".repeat(64) } };
        expect(await verifyPasskeyCosign(tampered, { ...EXPECTED, digest: "b".repeat(64) })).toEqual({
            ok: false,
            reason: "the passkey signed another challenge than this approval's",
        });
    });

    test("refuses a passkey scoped to another site than the rpId it claims", async () => {
        const cosign = softCosign(softPasskey(), CHALLENGE, "sbx-1.intentic.app", { scopedTo: "evil.example" });
        expect(await verifyPasskeyCosign(cosign, EXPECTED)).toEqual({ ok: false, reason: "the passkey is scoped to another site than sbx-1.intentic.app" });
        const claimed: PasskeyCosign = { ...softCosign(softPasskey(), CHALLENGE), rpId: "other.intentic.app" };
        expect(await verifyPasskeyCosign(claimed, EXPECTED)).toEqual({ ok: false, reason: "the passkey is scoped to another site than other.intentic.app" });
    });

    test("refuses an assertion without user verification, or without presence", async () => {
        const refusal = { ok: false, reason: "the authenticator did not confirm the person was present and verified" };
        expect(await verifyPasskeyCosign(softCosign(softPasskey(), CHALLENGE, undefined, { userVerified: false }), EXPECTED)).toEqual(refusal);
        expect(await verifyPasskeyCosign(softCosign(softPasskey(-8), CHALLENGE, undefined, { userPresent: false }), EXPECTED)).toEqual(refusal);
    });

    test("refuses a registration's client data, or anything not a webauthn.get", async () => {
        const cosign = softCosign(softPasskey(), CHALLENGE, undefined, { type: "webauthn.create" });
        expect(await verifyPasskeyCosign(cosign, EXPECTED)).toEqual({ ok: false, reason: "its client data is not a WebAuthn assertion (webauthn.get)" });
    });

    test.each([
        ["ES256", -7],
        ["EdDSA", -8],
        ["RS256", -257],
    ] as const)("refuses a %s signature under another key, and one with a byte changed", async (_name, alg) => {
        const cosign = softCosign(softPasskey(alg), CHALLENGE);
        const refusal = { ok: false, reason: "the signature does not verify under its key" };
        expect(await verifyPasskeyCosign({ ...cosign, publicKey: softPasskey(alg).publicKey }, EXPECTED)).toEqual(refusal);
        const bytes = fromBase64Url(cosign.signature) ?? new Uint8Array();
        bytes[bytes.length - 1] = (bytes.at(-1) ?? 0) ^ 0x01;
        expect(await verifyPasskeyCosign({ ...cosign, signature: toBase64Url(bytes) }, EXPECTED)).toEqual(refusal);
    });

    test("refuses a key whose JWK is not its algorithm's, and a body that is not a co-signature", async () => {
        const cosign = softCosign(softPasskey(-7), CHALLENGE);
        expect(await verifyPasskeyCosign({ ...cosign, publicKey: { alg: -8, jwk: cosign.publicKey.jwk } }, EXPECTED)).toEqual({
            ok: false,
            reason: "the signature does not verify under its key",
        });
        // SAFETY: a co-signature read off the wire may be anything; the verifier parses it before trusting a field.
        const junk = JSON.parse(`{"v":2}`) as PasskeyCosign;
        expect(await verifyPasskeyCosign(junk, EXPECTED)).toEqual({ ok: false, reason: "not a passkey co-signature" });
    });
});
