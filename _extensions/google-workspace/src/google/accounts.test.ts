import { describe, expect, it } from "vitest";
import { connectionsFrom, credentialOf, selectConnection } from "./accounts.js";

// The daemon writes these; the shape of the fixture IS the contract with cli-env.ts (envSuffix + one var per
// manifest env key), so it is spelled out rather than built by a helper that could drift from it.
const userEnv = (suffix: string, overrides: Record<string, string> = {}): Record<string, string> => ({
    [`GOOGLE_MODE_${suffix}`]: "user",
    [`GOOGLE_EMAIL_${suffix}`]: "ana@example.com",
    [`GOOGLE_ACCESS_${suffix}`]: "write",
    [`GOOGLE_CLIENT_ID_${suffix}`]: "client-id",
    [`GOOGLE_CLIENT_SECRET_${suffix}`]: "client-secret",
    [`GOOGLE_REFRESH_TOKEN_${suffix}`]: "refresh-token",
    [`GOOGLE_SERVICE_ACCOUNT_KEY_${suffix}`]: "",
    ...overrides,
});

const SERVICE_KEY = JSON.stringify({
    client_email: "bot@proj.iam.gserviceaccount.com",
    private_key: "-----BEGIN PRIVATE KEY-----\nx\n-----END PRIVATE KEY-----",
});

describe("connectionsFrom", () => {
    it("finds one connection per GOOGLE_MODE_* and names it after the suffix", () => {
        const found = connectionsFrom({ ...userEnv("GOOGLE"), ...userEnv("WORK_GMAIL", { GOOGLE_EMAIL_WORK_GMAIL: "ana@work.com" }) });
        expect(found.map((connection) => connection.name)).toEqual(["google", "work_gmail"]);
        expect(found.map((connection) => connection.email)).toEqual(["ana@example.com", "ana@work.com"]);
    });

    it("reads the credential a user card carries", () => {
        const [connection] = connectionsFrom(userEnv("GOOGLE"));
        expect(connection?.credential).toEqual({ mode: "user", clientId: "client-id", clientSecret: "client-secret", refreshToken: "refresh-token" });
        expect(connection?.problem).toBeUndefined();
    });

    it("parses a company card's service account key and defaults its token endpoint", () => {
        const [connection] = connectionsFrom({
            GOOGLE_MODE_CO: "domain",
            GOOGLE_EMAIL_CO: "ana@company.com",
            GOOGLE_ACCESS_CO: "write",
            GOOGLE_SERVICE_ACCOUNT_KEY_CO: SERVICE_KEY,
        });
        expect(connection?.credential).toMatchObject({
            mode: "domain",
            clientEmail: "bot@proj.iam.gserviceaccount.com",
            tokenUri: "https://oauth2.googleapis.com/token",
        });
    });

    // A card the owner half-filled must be VISIBLE with its reason, not absent — "no Google account is
    // connected" is the wrong sentence to show someone looking straight at their card.
    it("keeps a half-filled card and says what is missing", () => {
        const [connection] = connectionsFrom(userEnv("GOOGLE", { GOOGLE_REFRESH_TOKEN_GOOGLE: "" }));
        expect(connection?.credential).toBeUndefined();
        expect(connection?.problem).toBe("the card is missing its refresh token");
        expect(() => credentialOf(connection!)).toThrow(/missing its refresh token/);
    });

    it("calls a service account key that is not JSON what it is", () => {
        const [connection] = connectionsFrom({ GOOGLE_MODE_CO: "domain", GOOGLE_EMAIL_CO: "a@b.com", GOOGLE_SERVICE_ACCOUNT_KEY_CO: "not json" });
        expect(connection?.problem).toMatch(/not valid JSON/);
    });

    it("treats anything but an explicit read as read & write", () => {
        expect(connectionsFrom(userEnv("A", { GOOGLE_ACCESS_A: "read" }))[0]?.access).toBe("read");
        expect(connectionsFrom(userEnv("B", { GOOGLE_ACCESS_B: "" }))[0]?.access).toBe("write");
    });

    it("ignores everything in the environment that is not a Google card", () => {
        expect(connectionsFrom({ PATH: "/usr/bin", GITHUB_TOKEN_GITHUB: "x" })).toEqual([]);
    });
});

describe("selectConnection", () => {
    const [one] = connectionsFrom(userEnv("GOOGLE"));
    const both = connectionsFrom({ ...userEnv("GOOGLE"), ...userEnv("WORK_GMAIL", { GOOGLE_EMAIL_WORK_GMAIL: "ana@work.com" }) });

    it("takes the only connection when there is one", () => {
        expect(selectConnection([one!], undefined).name).toBe("google");
    });

    it("says how to add one when there are none", () => {
        expect(() => selectConnection([], undefined)).toThrow(/No Google account is connected/);
    });

    /* The case this function exists for. Picking the first would send mail from whichever card sorted first,
     * which nobody notices until it is in someone's inbox. */
    it("refuses to guess between several, and lists them", () => {
        expect(() => selectConnection(both, undefined)).toThrow(/pass --account.*google.*work_gmail/s);
    });

    it("selects by name, by the name Google-cased, and by email", () => {
        expect(selectConnection(both, "work_gmail").name).toBe("work_gmail");
        expect(selectConnection(both, "work-gmail").name).toBe("work_gmail");
        expect(selectConnection(both, "ana@work.com").name).toBe("work_gmail");
    });

    it("names what IS connected when the wanted one is not", () => {
        expect(() => selectConnection(both, "personal")).toThrow(/No connected Google account called "personal"/);
    });
});
