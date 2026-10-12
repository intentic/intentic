import { generateKeyPairSync } from "node:crypto";
import {
    IDENTITY_ASSERTION_MAX_TTL_MS,
    IDENTITY_ASSERTION_TTL_MS,
    isIdentityAssertion,
    mintIdentityAssertion,
    verifyIdentityAssertion,
} from "../identity-assertion.js";
import { mintOwnerTicket, publicKeyPemOf, verifyOwnerTicket } from "../owner-ticket.js";

// PEM strings straight from the generator, the form the platform's env and the machine's env carry.
const pemPair = (): { privateKey: string; publicKey: string } =>
    generateKeyPairSync("ed25519", { publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
const { privateKey: privatePem, publicKey: publicPem } = pemPair();
const NOW = 1_800_000_000_000;
const SANDBOX = "0123456789ab";

const mint = (overrides: Partial<Parameters<typeof mintIdentityAssertion>[1]> = {}): string =>
    mintIdentityAssertion(privatePem, { sandboxId: SANDBOX, email: "Ada@Example.org", method: "email", issuedAtMs: NOW, ...overrides });

describe("identity assertion", () => {
    it("round-trips the claim, lowercased, and expires when it says", () => {
        const assertion = mint();
        expect(isIdentityAssertion(assertion)).toBe(true);
        expect(verifyIdentityAssertion(publicPem, assertion, NOW + 1_000)).toEqual({
            sandboxId: SANDBOX,
            email: "ada@example.org",
            method: "email",
            issuedAt: NOW / 1000,
            expiresAt: (NOW + IDENTITY_ASSERTION_TTL_MS) / 1000,
            nonce: expect.stringMatching(/^[A-Za-z0-9_-]{22}$/),
        });
        expect(verifyIdentityAssertion(publicPem, assertion, NOW + IDENTITY_ASSERTION_TTL_MS)).toBeUndefined();
    });

    it("gives every mint its own nonce, so a daemon can spend each once", () => {
        const first = verifyIdentityAssertion(publicPem, mint(), NOW);
        const second = verifyIdentityAssertion(publicPem, mint(), NOW);
        expect(first?.nonce).not.toBe(second?.nonce);
    });

    it("verifies against the public half derived from the platform's private key", () => {
        expect(verifyIdentityAssertion(publicKeyPemOf(privatePem), mint({ method: "google" }), NOW)).toMatchObject({ method: "google" });
    });

    it("refuses another key's signature, a tampered claim, and garbage", () => {
        const other = pemPair().publicKey;
        const assertion = mint();
        expect(verifyIdentityAssertion(other, assertion, NOW)).toBeUndefined();
        const [prefix, , signature] = assertion.split(".");
        const forged = Buffer.from(
            JSON.stringify({ v: 1, sub: SANDBOX, email: "eve@example.org", amr: "email", iat: NOW / 1000, exp: NOW / 1000 + 60, jti: "x".repeat(22) }),
        ).toString("base64url");
        expect(verifyIdentityAssertion(publicPem, `${prefix}.${forged}.${signature}`, NOW)).toBeUndefined();
        expect(verifyIdentityAssertion(publicPem, "pa1.not.base64", NOW)).toBeUndefined();
        expect(verifyIdentityAssertion(publicPem, `${assertion}.extra`, NOW)).toBeUndefined();
        expect(isIdentityAssertion("ot1.x.y")).toBe(false);
    });

    it("refuses a claim issued more than a minute ahead of the daemon's clock", () => {
        expect(verifyIdentityAssertion(publicPem, mint({ issuedAtMs: NOW + 61_000 }), NOW)).toBeUndefined();
        expect(verifyIdentityAssertion(publicPem, mint({ issuedAtMs: NOW + 59_000 }), NOW)).toMatchObject({ email: "ada@example.org" });
    });

    /* One key could sign tickets and assertions if an operator reused it; neither may pass as the other. */
    it("is never an owner ticket, and an owner ticket is never an assertion", () => {
        const ticket = mintOwnerTicket(privatePem, { sandboxId: SANDBOX, email: "ada@example.org", issuedAtMs: NOW });
        expect(verifyIdentityAssertion(publicPem, ticket, NOW)).toBeUndefined();
        expect(verifyIdentityAssertion(publicPem, `pa1.${ticket.slice("ot1.".length)}`, NOW)).toBeUndefined();
        expect(verifyOwnerTicket(publicPem, mint(), NOW)).toBeUndefined();
    });

    it("refuses to mint for anything but a real sandbox id, an address, and a short life", () => {
        expect(() => mint({ sandboxId: "nope" })).toThrow("12-hex sandbox id");
        expect(() => mint({ email: " " })).toThrow("names an address");
        expect(() => mint({ ttlMs: IDENTITY_ASSERTION_MAX_TTL_MS + 1 })).toThrow("lives at most");
        expect(() => mint({ ttlMs: 0 })).toThrow("lives at most");
    });
});
