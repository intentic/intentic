import { generateKeyPairSync } from "node:crypto";
import { readFileSync } from "node:fs";
import { hostOwnerId, type ReachabilityGrant, mintReachabilityGrant, verifyReachabilityGrant } from "./ingress-contract.js";

// The edge's rules as both implementations must answer them; the Rust edge reads the same file. Its grants were minted
// by a throwaway pair whose private half was never kept, so a new grant case takes a new pair and every token again.
const FIXTURE = JSON.parse(readFileSync(new URL("./ingress-contract.fixture.json", import.meta.url), "utf8")) as {
    readonly publicKey: string;
    readonly grants: readonly { readonly token: string; readonly claim: ReachabilityGrant | null }[];
    readonly owners: readonly { readonly host: string; readonly owner: string | null }[];
};

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

    it("answers every grant in the shared fixture as it states, and garbage with undefined rather than a throw", () => {
        // Both verdicts, so the loop below can never pass by holding only one kind of case.
        expect(new Set(FIXTURE.grants.map(({ claim }) => (claim === null ? "refused" : "accepted")))).toEqual(new Set(["accepted", "refused"]));
        for (const { token, claim } of FIXTURE.grants) {
            expect({ token, claim: verifyReachabilityGrant(FIXTURE.publicKey, token) ?? null }).toEqual({ token, claim });
        }
    });

    it("refuses to mint for something that is not a sandbox id", () => {
        expect(() => mintReachabilityGrant(pemPair().privateKey, "not-an-id", Date.now())).toThrow(/12-hex/);
    });
});

describe("hostOwnerId", () => {
    it("owns every host in the shared fixture as it states, port or not", () => {
        for (const { host, owner } of FIXTURE.owners) {
            expect({ host, owner: hostOwnerId(host) ?? null }).toEqual({ host, owner });
        }
    });
});
