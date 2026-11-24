import { createPrivateKey, generateKeyPairSync, sign } from "node:crypto";
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
            scope: "report",
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

    // An organisation's line, said by the platform: present only when the two sides differ, and a pass without it reads
    // as before.
    it("carries the organisations a report crosses, and nothing when it crosses none", () => {
        const crossesOrg = { from: { id: "org_1", name: "Acme" } };
        expect(verifySandboxPass(publicPem, mint({ crossesOrg }), NOW)).toMatchObject({ crossesOrg });
        const both = { from: { id: "org_1", name: "Acme" }, to: { id: "org_2", name: "Globex" } };
        expect(verifySandboxPass(publicPem, mint({ crossesOrg: both }), NOW)?.crossesOrg).toEqual(both);
        expect(verifySandboxPass(publicPem, mint(), NOW)).not.toHaveProperty("crossesOrg");
        expect(verifySandboxPass(publicPem, mint({ crossesOrg: {} }), NOW)).not.toHaveProperty("crossesOrg");
    });

    // A pass that routes as a person names that one person and no project; a report names its project. A daemon from
    // before scopes reads any pass with a project as a report, which is why no other scope may carry one.
    it("routes as one named person for every scope but a report, and never carries a project there", () => {
        const drop = verifySandboxPass(publicPem, mint({ scope: "drop", project: undefined, person: " Ada@Example.com " }), NOW);
        expect(drop).toMatchObject({ scope: "drop", person: "ada@example.com" });
        expect(drop).not.toHaveProperty("project");
        expect(verifySandboxPass(publicPem, mint({ person: "ada@example.com" }), NOW)).toMatchObject({ scope: "report", person: "ada@example.com" });
        expect(() => mint({ scope: "task", person: "ada@example.com" })).toThrow();
        expect(() => mint({ scope: "read", project: undefined })).toThrow();
        expect(() => mint({ project: undefined })).toThrow();
    });

    it("refuses a scope this build does not know, rather than reading it as another", () => {
        const [prefix, payload] = mint({ scope: "read", project: undefined, person: "ada@example.com" }).split(".");
        const unknown = Buffer.from(Buffer.from(payload ?? "", "base64url").toString("utf8").replace(`"read"`, `"operate"`), "utf8").toString("base64url");
        // Signed properly, by the right key: only the scope is one no build knows.
        const signature = sign(null, Buffer.concat([Buffer.from(`${prefix}.`), Buffer.from(unknown, "base64url")]), createPrivateKey(privatePem)).toString("base64url");
        expect(verifySandboxPass(publicPem, `${prefix}.${unknown}.${signature}`, NOW)).toBeUndefined();
    });

    it("refuses to mint a pass to itself or one that lives too long", () => {
        expect(() => mint({ to: A })).toThrow();
        expect(() => mint({ ttlMs: SANDBOX_PASS_MAX_TTL_MS + 1 })).toThrow();
        expect(() => mint({ project: " " })).toThrow();
    });
});
