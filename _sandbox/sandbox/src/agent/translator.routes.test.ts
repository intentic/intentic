import { expect, test } from "vitest";
import { createApp } from "../app.js";
import { clientFor, postJson, services, withTranslator } from "../route-testing.js";
import { TRANSLATOR_BINARY_MISSING } from "./translator.js";

/* THE SENTENCE THE TRANSLATOR WROTE IS THE SENTENCE THE USER READS.
 *
 * Every failure the CLIProxyAPI client can produce is already a sentence aimed at the person looking at the
 * Agent tab — "rebuild the image to add the translator", "Google sign-in failed to start (503)", or the
 * proxy's own reason for rejecting a pasted redirect URL. They all used to reach the browser as a bare
 * "Internal server error": oRPC replaces the message of any throw that is not an ORPCError, so the four
 * handlers here were deleting the one useful thing in each failure.
 *
 * That is the whole bug behind the report "my Google accounts expired and now I get Internal server error",
 * and behind the same string greeting new users — a sandbox on a core image has no translator binary at all,
 * so pressing Connect could only ever produce the one message that never got through.
 *
 * These tests assert the MESSAGE reaches a client, not the code: the message is what the card prints. */

const failing = (error: Error) => ({
    accounts: async () => {
        throw error;
    },
    refreshUsage: async () => {},
    turnLimit: async () => ({ spent: 0, withHeadroom: 0 }),
    connect: async () => {
        throw error;
    },
    complete: async () => {
        throw error;
    },
    disconnect: async () => {
        throw error;
    },
    models: async () => [],
});

test("a connect failure reaches the browser as the translator's own sentence, not Internal server error", async () => {
    const app = createApp(services({ config: withTranslator, cliProxy: failing(new Error(TRANSLATOR_BINARY_MISSING)) }));

    const response = await postJson(app, "/translator/gemini/connect", { provider: "gemini" });
    const body = (await response.json()) as { message?: string };

    expect(body.message).toBe(TRANSLATOR_BINARY_MISSING);
    expect(body.message).not.toBe("Internal server error");
});

test("a completion failure carries the reason CLIProxyAPI gave for rejecting the pasted URL", async () => {
    const reason = "state does not match any pending sign-in — start the connection again";
    const app = createApp(services({ config: withTranslator, cliProxy: failing(new Error(reason)) }));

    const response = await postJson(app, "/translator/gemini/complete", {
        provider: "gemini",
        redirectUrl: "http://localhost:51121/oauth-callback?code=abc&state=xyz",
        state: "xyz",
    });

    expect(((await response.json()) as { message?: string }).message).toBe(reason);
});

test("a disconnect failure says what went wrong instead of Internal server error", async () => {
    const app = createApp(services({ config: withTranslator, cliProxy: failing(new Error("the translator refused to drop that credential")) }));

    const response = await postJson(app, "/translator/gemini/disconnect", { provider: "gemini", name: "antigravity-user.json" });

    expect(((await response.json()) as { message?: string }).message).toBe("the translator refused to drop that credential");
});

test("a listing failure says so rather than claiming the sandbox has no subscriptions", async () => {
    const client = clientFor(createApp(services({ config: withTranslator, cliProxy: failing(new Error("could not read the credential store")) })));

    await expect(client.translator.accounts()).rejects.toThrow("could not read the credential store");
});
