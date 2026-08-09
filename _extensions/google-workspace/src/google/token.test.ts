import { createVerify, generateKeyPairSync } from "node:crypto";
import { describe, expect, it } from "vitest";
import type { Connection, Credential } from "./accounts.js";
import { assertionFor, tokenFailure } from "./token.js";

const { privateKey, publicKey } = generateKeyPairSync("rsa", { modulusLength: 2048 });

const domain: Extract<Credential, { mode: "domain" }> = {
    mode: "domain",
    clientEmail: "bot@proj.iam.gserviceaccount.com",
    privateKey: privateKey.export({ type: "pkcs8", format: "pem" }).toString(),
    tokenUri: "https://oauth2.googleapis.com/token",
};

const connection: Connection = {
    name: "company",
    email: "ana@company.com",
    access: "write",
    mode: "domain",
    credential: domain,
    problem: undefined,
};

const decode = (segment: string): Record<string, unknown> => JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as Record<string, unknown>;

describe("assertionFor", () => {
    const assertion = assertionFor(domain, "ana@company.com", ["https://www.googleapis.com/auth/gmail.modify"], 1_770_000_000);
    const [header, claims, signature] = assertion.split(".");

    it("claims to be the service account acting AS the named person — which is the whole of delegation", () => {
        expect(decode(claims as string)).toEqual({
            iss: "bot@proj.iam.gserviceaccount.com",
            sub: "ana@company.com",
            scope: "https://www.googleapis.com/auth/gmail.modify",
            aud: "https://oauth2.googleapis.com/token",
            iat: 1_770_000_000,
            exp: 1_770_003_600,
        });
    });

    it("is an RS256 JWT", () => {
        expect(decode(header as string)).toEqual({ alg: "RS256", typ: "JWT" });
    });

    // Verified rather than merely present: a signature over the wrong bytes is a token endpoint's 400, and a
    // shape assertion would not tell them apart.
    it("signs the header and claims with the account's private key", () => {
        const verifier = createVerify("RSA-SHA256").update(`${header}.${claims}`);
        expect(verifier.verify(publicKey, Buffer.from(signature as string, "base64url"))).toBe(true);
    });
});

describe("tokenFailure", () => {
    /* The failure this integration actually dies of, and the reason it gets its own sentence: Google says
     * "Bad Request", and the cause is a consent screen left in Testing seven days ago. */
    it("names the 7-day Testing trap on a rejected refresh token", () => {
        const message = tokenFailure(connection, "user", "invalid_grant", "Bad Request");
        expect(message).toMatch(/"Testing" issues refresh tokens that die after 7 days/);
        expect(message).toMatch(/In production/);
    });

    it("points a rejected company grant at domain-wide delegation instead", () => {
        expect(tokenFailure(connection, "domain", "invalid_grant", undefined)).toMatch(/domain-wide delegation/);
        expect(tokenFailure(connection, "domain", "unauthorized_client", undefined)).toMatch(/admin\.google\.com/);
    });

    it("blames the client pair when Google rejects the client", () => {
        expect(tokenFailure(connection, "user", "invalid_client", undefined)).toMatch(/client ID and secret came from the same credential/);
    });

    it("relays anything unrecognised with both what Google said and which account it was about", () => {
        const message = tokenFailure(connection, "user", "some_new_error", "explained here");
        expect(message).toContain("company (ana@company.com)");
        expect(message).toContain("some_new_error");
        expect(message).toContain("explained here");
    });
});
