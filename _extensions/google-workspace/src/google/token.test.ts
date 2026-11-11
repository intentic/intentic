import { createVerify, generateKeyPairSync } from "node:crypto";
import type { Connection, Credential } from "./accounts.js";
import { PlatformAccessRefused } from "@intentic/connector-runtime";
import { assertionFor, mintToken, tokenFailure } from "./token.js";

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

const decode = (segment: string): Record<string, unknown> =>
    JSON.parse(Buffer.from(segment, "base64url").toString("utf8")) as Record<string, unknown>;

describe("assertionFor", () => {
    const assertion = assertionFor(domain, "ana@company.com", ["https://www.googleapis.com/auth/gmail.modify"], 1_770_000_000);
    const [header, claims, signature] = assertion.split(".");

    it("claims to be the service account acting AS the named person, which is the whole of delegation", () => {
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
    /* Token failures include Google's concrete cause. */
    it("names the 7-day Testing trap on a rejected refresh token", () => {
        const message = tokenFailure(connection, "user", "invalid_grant", "Bad Request");
        expect(message).toMatch(/"Testing" issues refresh tokens that die after 7 days/);
        expect(message).toMatch(/In production/);
    });

    it("points a rejected company grant at domain-wide delegation instead", () => {
        expect(tokenFailure(connection, "domain", "invalid_grant", undefined)).toMatch(/domain-wide delegation/);
        expect(tokenFailure(connection, "domain", "unauthorized_client", undefined)).toContain("admin.google.com");
    });

    it("sends a Connect Google card back to its Reconnect button, never to the Cloud console", () => {
        const message = tokenFailure(connection, "platform", "invalid_grant", undefined);
        expect(message).toMatch(/Reconnect on its card/);
        expect(message).not.toMatch(/Testing/);
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

describe("mintToken on a Connect Google card", () => {
    const platform: Connection = { ...connection, mode: "user", credential: { mode: "platform", cardId: "work", refreshToken: "rt" } };

    it("asks the daemon for the card's token and keeps it for its hour", async () => {
        const mint = jest.fn().mockResolvedValue({ accessToken: "at", expiresIn: 3599 });
        expect(await mintToken(platform, { mode: "platform", cardId: "work", refreshToken: "rt" }, 1000, mint)).toEqual({ token: "at", expiresAt: 4599 });
        expect(mint).toHaveBeenCalledWith("work");
    });

    it("puts Google's refusal into what the owner does about it", async () => {
        const mint = jest.fn().mockRejectedValue(new PlatformAccessRefused("invalid_grant", 400));
        await expect(mintToken(platform, { mode: "platform", cardId: "work", refreshToken: "rt" }, 1000, mint)).rejects.toThrow(/Reconnect on its card/);
        const offline = jest.fn().mockRejectedValue(new PlatformAccessRefused("the platform could not be reached to refresh the sign-in", 502));
        await expect(mintToken(platform, { mode: "platform", cardId: "work", refreshToken: "rt" }, 1000, offline)).rejects.toThrow(/could not be reached/);
    });
});
