import { generateKeyPairSync } from "node:crypto";
import { mintIdentityAssertion, verifyIdentityAssertion } from "../../policy/identity-assertion.js";
import { isSandboxPass, mintSandboxPass, SANDBOX_PASS_MAX_TTL_MS, SANDBOX_PASS_TTL_MS, verifySandboxPass } from "./sandbox-pass.js";

const pemPair = (): { privateKey: string; publicKey: string } =>
    generateKeyPairSync("ed25519", { publicKeyEncoding: { type: "spki", format: "pem" }, privateKeyEncoding: { type: "pkcs8", format: "pem" } });
const { privateKey: privatePem, publicKey: publicPem } = pemPair();
const NOW = 1_800_000_000_000;
const A = "0123456789ab";
const B = "ba9876543210";

const mint = (overrides: Partial<Parameters<typeof mintSandboxPass>[1]> = {}): string =>
    mintSandboxPass(privatePem, { from: A, fromName: "ops", to: B, project: "github.com/acme/app", issuedAtMs: NOW, ...overrides });

describe("sandbox pass", () => {
    it("round-trips the claim and expires when it says", () => {
        const pass = mint();
        expect(isSandboxPass(pass)).toBe(true);
        expect(verifySandboxPass(publicPem, pass, NOW + 1_000)).toEqual({
            from: A,
            fromName: "ops",
            to: B,
            project: "github.com/acme/app",
            issuedAt: NOW / 1000,
            expiresAt: (NOW + SANDBOX_PASS_TTL_MS) / 1000,
        });
        expect(verifySandboxPass(publicPem, pass, NOW + SANDBOX_PASS_TTL_MS)).toBeUndefined();
    });

    it("refuses another key, a tampered payload, and a claim from the future", () => {
        expect(verifySandboxPass(pemPair().publicKey, mint(), NOW)).toBeUndefined();
        const [prefix, payload, signature] = mint().split(".");
        const forged = Buffer.from(Buffer.from(payload ?? "", "base64url").toString("utf8").replace(B, A.replace("0", "f")), "utf8").toString("base64url");
        expect(verifySandboxPass(publicPem, `${prefix}.${forged}.${signature}`, NOW)).toBeUndefined();
        expect(verifySandboxPass(publicPem, mint({ issuedAtMs: NOW + 120_000 }), NOW)).toBeUndefined();
    });

    it("is never an identity assertion, nor the reverse, under the same key", () => {
        const pass = mint();
        expect(verifyIdentityAssertion(publicPem, pass, NOW)).toBeUndefined();
        const assertion = mintIdentityAssertion(privatePem, { sandboxId: B, email: "a@b.org", method: "email", issuedAtMs: NOW });
        expect(verifySandboxPass(publicPem, assertion, NOW)).toBeUndefined();
        expect(verifySandboxPass(publicPem, assertion.replace(/^pa1/, "sp1"), NOW)).toBeUndefined();
    });

    it("refuses to mint a pass to itself or one that lives too long", () => {
        expect(() => mint({ to: A })).toThrow();
        expect(() => mint({ ttlMs: SANDBOX_PASS_MAX_TTL_MS + 1 })).toThrow();
        expect(() => mint({ project: " " })).toThrow();
    });
});
