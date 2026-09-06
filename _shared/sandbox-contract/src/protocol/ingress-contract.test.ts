import { generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import { hostOwnerId, mintReachabilityGrant, verifyReachabilityGrant } from "./ingress-contract.js";

const pemPair = (): { privateKey: string; publicKey: string } => {
    const { privateKey, publicKey } = generateKeyPairSync("ed25519");
    return {
        privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
        publicKey: publicKey.export({ type: "spki", format: "pem" }).toString(),
    };
};

const SANDBOX_ID = "abc123def456";

describe("reachability grant", () => {
    it("round-trips through mint and verify", () => {
        const keys = pemPair();
        const token = mintReachabilityGrant(keys.privateKey, SANDBOX_ID, 1_700_000_000_123);
        expect(verifyReachabilityGrant(keys.publicKey, token)).toEqual({ sandboxId: SANDBOX_ID, issuedAt: 1_700_000_000 });
    });

    it("refuses a grant signed by another key", () => {
        const token = mintReachabilityGrant(pemPair().privateKey, SANDBOX_ID, Date.now());
        expect(verifyReachabilityGrant(pemPair().publicKey, token)).toBeUndefined();
    });

    it("refuses a tampered payload", () => {
        const keys = pemPair();
        const token = mintReachabilityGrant(keys.privateKey, SANDBOX_ID, Date.now());
        const [prefix, , signature] = token.split(".");
        const forged = Buffer.from(JSON.stringify({ sub: "000000000000", iat: 1 }), "utf8").toString("base64url");
        expect(verifyReachabilityGrant(keys.publicKey, `${prefix}.${forged}.${signature}`)).toBeUndefined();
    });

    it("answers undefined for garbage rather than throwing", () => {
        const keys = pemPair();
        for (const junk of ["", "ig1", "ig1..", "nonsense.a.b", "ig2.a.b", "ig1.%%%.%%%"]) {
            expect(verifyReachabilityGrant(keys.publicKey, junk)).toBeUndefined();
        }
    });

    it("refuses to mint for something that is not a sandbox id", () => {
        expect(() => mintReachabilityGrant(pemPair().privateKey, "not-an-id", Date.now())).toThrow(/12-hex/);
    });
});

describe("hostOwnerId", () => {
    it("owns the daemon's own name and every labelled name", () => {
        expect(hostOwnerId(`sandbox-${SANDBOX_ID}.sbx.example.dev`)).toBe(SANDBOX_ID);
        expect(hostOwnerId(`preview-operator-${SANDBOX_ID}.sbx.example.dev`)).toBe(SANDBOX_ID);
        expect(hostOwnerId(`port-0f0f0f0f0f0f-${SANDBOX_ID}.sbx.example.dev`)).toBe(SANDBOX_ID);
        expect(hostOwnerId(`public-1a2b3c4d5e6f-${SANDBOX_ID}.sbx.example.dev`)).toBe(SANDBOX_ID);
    });

    it("ignores a port suffix", () => {
        expect(hostOwnerId(`sandbox-${SANDBOX_ID}.sbx.example.dev:443`)).toBe(SANDBOX_ID);
    });

    it("owns nothing that does not end in a 12-hex tail", () => {
        // The ingress's own door, the zone apex, the loopback name's bare-id label, and a near-miss tail.
        for (const host of ["ingress.sbx.example.dev", "sbx.example.dev", `${SANDBOX_ID}.local.sbx.example.dev`, "sandbox-abc123def45.sbx.example.dev", ""]) {
            expect(hostOwnerId(host)).toBeUndefined();
        }
    });
});
