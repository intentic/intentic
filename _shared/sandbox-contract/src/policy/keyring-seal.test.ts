import { readFileSync } from "node:fs";
import { join } from "node:path";
import { packageRoot } from "@intentic/constants/node";
import type { KeyringGrant, SealedBox } from "../schemas/keyring.js";
import { SealedBoxSchema } from "../schemas/keyring.js";
import { grantNonce, keyFingerprint, newSealKeyPair, newSignKeyPair, seal, sealWithEphemeral, signGrant, unseal, verifyGrant, type SealPurpose } from "./keyring-seal.js";

const goldenPath = join(packageRoot(import.meta.url), "golden", "keyring-seal.json");
const golden = JSON.parse(readFileSync(goldenPath, "utf8")) as {
    recipient: { publicKey: string; privateKey: string };
    phone: { publicKey: string; privateKey: string };
    vectors: Array<{
        name: string;
        plaintext: string;
        purpose: SealPurpose;
        ephemeral: { publicKey: string; privateKey: string };
        iv: string;
        box: SealedBox;
    }>;
    unseal: { phonePlaintext: string; phonePurpose: SealPurpose };
};

const SANDBOX = "https://a1b2c3d4e5f6.intentic.dev";

const grantAt = (now: number, over: Partial<KeyringGrant> = {}): KeyringGrant => ({
    v: 1,
    sandbox: SANDBOX,
    secret: "VPN_FORTI",
    target: { kind: "window", programs: ["FortiClient.exe"], anyField: false },
    purpose: "agent",
    detail: "FortiClient sign-in",
    nonce: grantNonce(),
    issuedAt: now,
    expiresAt: now + 60_000,
    ...over,
});

describe("sealed boxes", () => {
    test("open for their own key and purpose", () => {
        const pair = newSealKeyPair();
        const purpose = { kind: "release", sandbox: SANDBOX, secret: "VPN_FORTI", nonce: grantNonce() } as const;
        const box = seal(pair.publicKey, "hunter2-but-longer", purpose);
        expect(unseal(pair, box, purpose)).toBe("hunter2-but-longer");
    });

    test("refuse another key", () => {
        const purpose = { kind: "inbox", sandbox: SANDBOX, secret: "X" } as const;
        const box = seal(newSealKeyPair().publicKey, "value", purpose);
        expect(() => unseal(newSealKeyPair(), box, purpose)).toThrow();
    });

    test("refuse another purpose, so one release cannot stand in for another", () => {
        const pair = newSealKeyPair();
        const nonce = grantNonce();
        const box = seal(pair.publicKey, "value", { kind: "release", sandbox: SANDBOX, secret: "A", nonce });
        expect(() => unseal(pair, box, { kind: "release", sandbox: SANDBOX, secret: "B", nonce })).toThrow();
        expect(() => unseal(pair, box, { kind: "type", sandbox: SANDBOX, secret: "A", nonce })).toThrow();
    });

    test("are fresh every time, so equal values do not look equal", () => {
        const pair = newSealKeyPair();
        const purpose = { kind: "inbox", sandbox: SANDBOX, secret: "X" } as const;
        expect(seal(pair.publicKey, "same", purpose).data).not.toBe(seal(pair.publicKey, "same", purpose).data);
    });
});

describe("grants", () => {
    test("verify under the signing key", () => {
        const pair = newSignKeyPair();
        const now = Date.now();
        const verdict = verifyGrant(pair.publicKey, signGrant(pair, grantAt(now)), now + 1000);
        expect(verdict.ok).toBe(true);
        expect(verdict.ok && verdict.grant.secret).toBe("VPN_FORTI");
    });

    test("refuse another sandbox's key", () => {
        const now = Date.now();
        const verdict = verifyGrant(newSignKeyPair().publicKey, signGrant(newSignKeyPair(), grantAt(now)), now);
        expect(verdict).toMatchObject({ ok: false, code: "bad-grant" });
    });

    test("refuse a payload changed after signing", () => {
        const pair = newSignKeyPair();
        const now = Date.now();
        const signed = signGrant(pair, grantAt(now));
        // SAFETY: the payload is the grant signGrant just serialised, so it parses back to one.
        const body = JSON.parse(Buffer.from(signed.payload, "base64url").toString("utf8")) as KeyringGrant;
        const changed = Buffer.from(JSON.stringify({ ...body, secret: "BANK" }), "utf8").toString("base64url");
        expect(verifyGrant(pair.publicKey, { ...signed, payload: changed }, now)).toMatchObject({ ok: false, code: "bad-grant" });
    });

    test("expire", () => {
        const pair = newSignKeyPair();
        const now = Date.now();
        expect(verifyGrant(pair.publicKey, signGrant(pair, grantAt(now)), now + 61_000)).toMatchObject({ ok: false, code: "expired" });
    });

    test("are never signed for longer than two minutes", () => {
        const now = Date.now();
        expect(() => signGrant(newSignKeyPair(), grantAt(now, { expiresAt: now + 5 * 60_000 }))).toThrow();
    });

    test("from far in the future are not this sandbox's", () => {
        const pair = newSignKeyPair();
        const now = Date.now();
        expect(verifyGrant(pair.publicKey, signGrant(pair, grantAt(now + 10 * 60_000)), now)).toMatchObject({ ok: false, code: "bad-grant" });
    });
});

test("fingerprints read in groups of four", () => {
    expect(keyFingerprint(newSealKeyPair().publicKey)).toMatch(/^[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}-[0-9A-F]{4}$/u);
});

describe("golden vectors (shared with the Android app)", () => {
    test.each(golden.vectors)("$name seals to the golden box", ({ name, plaintext, purpose, ephemeral, iv, box }) => {
        const recipient = name === "phone" ? golden.phone.publicKey : golden.recipient.publicKey;
        const rebuilt = sealWithEphemeral(recipient, plaintext, purpose, ephemeral, Buffer.from(iv, "base64url"));
        expect(rebuilt).toEqual(SealedBoxSchema.parse(box));
    });

    test("the phone opens the golden phone box", () => {
        const phoneVector = golden.vectors.find((vector) => vector.name === "phone");
        if (phoneVector === undefined) {
            throw new Error("the golden file has no phone vector");
        }
        expect(unseal(golden.phone, phoneVector.box, phoneVector.purpose)).toBe(golden.unseal.phonePlaintext);
    });
});
