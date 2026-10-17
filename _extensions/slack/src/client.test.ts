import { WebAPIPlatformError, WebAPIRequestError } from "@slack/web-api";
import { authFailure, FatalSlackError } from "./client.js";

// A refused start is read by the code Slack answered with, which the SDK's own error carries, not by its sentence.

const refusal = (code: string): WebAPIPlatformError => new WebAPIPlatformError({ ok: false, error: code });

describe("authFailure", () => {
    test("a dead token is fatal and names the field to fix", () => {
        const failure = authFailure(refusal("token_revoked"), "appToken", "xapp-");
        expect(failure).toBeInstanceOf(FatalSlackError);
        expect(failure.message).toContain("appToken (token_revoked)");
    });

    test("a missing scope is fatal", () => {
        expect(authFailure(refusal("missing_scope"), "botToken", "xoxb-")).toBeInstanceOf(FatalSlackError);
    });

    test("the SDK's sentence is not what decides", () => {
        const reworded = refusal("invalid_auth");
        reworded.message = "Slack said no";
        expect(authFailure(reworded, "botToken", "xoxb-")).toBeInstanceOf(FatalSlackError);
        // A sentence that only mentions a code, from no Slack answer, is a failure to retry.
        const network = new WebAPIRequestError(new Error("invalid_auth while connecting"));
        expect(authFailure(network, "botToken", "xoxb-")).toBe(network);
    });

    test("any other refusal is passed on to retry", () => {
        const limited = refusal("ratelimited");
        expect(authFailure(limited, "botToken", "xoxb-")).toBe(limited);
    });
});
