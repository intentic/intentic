import { describe, expect, it } from "vitest";
import { googleError, retryDelay } from "./request.js";

describe("retryDelay", () => {
    it("backs off exponentially when Google says nothing", () => {
        expect(retryDelay(1, null)).toBe(500);
        expect(retryDelay(2, null)).toBe(1000);
        expect(retryDelay(3, null)).toBe(2000);
    });

    it("obeys Retry-After, which is authoritative when a quota refusal carries one", () => {
        expect(retryDelay(1, "5")).toBe(5000);
    });

    // A server that answers Retry-After: 3600 must not park a CLI command for an hour.
    it("caps a declared wait, and ignores a nonsense one", () => {
        expect(retryDelay(1, "3600")).toBe(30_000);
        expect(retryDelay(2, "Wed, 21 Oct 2026 07:28:00 GMT")).toBe(1000);
    });
});

describe("googleError", () => {
    const at = (service: string): string => `https://${service}.googleapis.com/v1/whatever`;

    /* The single most common first failure: a project where nobody enabled the API. Google's own message
     * describes the situation and never says the words that fix it, so this one names the console. */
    it("turns a disabled API into the instruction that enables it", () => {
        const error = googleError(403, at("gmail"), {
            error: { message: "Gmail API has not been used in project 12345 before or it is disabled." },
        });
        expect(error.message).toContain("console.cloud.google.com");
        expect(error.message).toContain("Gmail API");
    });

    it("explains an insufficient-scope refusal as a consent that was too narrow", () => {
        const error = googleError(403, at("calendar"), { error: { message: "Request had insufficient authentication scopes." } });
        expect(error.message).toMatch(/approved for narrower scopes/);
        expect(error.message).toMatch(/domain-wide delegation/);
    });

    it("suggests the two things a 404 actually means", () => {
        expect(googleError(404, at("drive"), { error: { message: "File not found: abc." } }).message).toMatch(
            /check the id, and that this account can actually see it|see that item/,
        );
    });

    it("says a rate limit is a rate limit", () => {
        expect(googleError(429, at("gmail"), { error: { message: "User-rate limit exceeded." } }).message).toMatch(/rate-limiting this account/);
    });

    it("relays anything else as Google phrased it, and keeps the status", () => {
        const error = googleError(400, at("sheets"), { error: { message: "Unable to parse range: Sheet9!A1" } });
        expect(error.message).toBe("Unable to parse range: Sheet9!A1");
        expect(error.status).toBe(400);
    });

    it("still says something when the body is not the shape Google documents", () => {
        expect(googleError(502, at("drive"), "<html>bad gateway</html>").message).toBe("HTTP 502");
    });
});
