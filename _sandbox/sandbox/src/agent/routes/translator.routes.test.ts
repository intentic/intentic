import { expect, test, vi } from "vitest";
import { createApp } from "../../app.js";
import { clientFor, postJson } from "../../harness/route-client.testing.js";
import { services, withTranslator } from "../../harness/route-services.testing.js";
import { TRANSLATOR_BINARY_MISSING } from "../providers/translator.js";

// Asserts the translator's own error message reaches the client instead of oRPC's generic 'Internal server error' for
// non-ORPCError throws.

const failing = (error: Error) => ({
    accounts: async () => {
        throw error;
    },
    refreshUsage: async () => {},
    turnLimit: async () => ({ spent: 0, withHeadroom: 0 }),
    connect: async () => {
        throw error;
    },
    status: async () => {
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
    const reason = "state does not match any pending sign-in: start the connection again";
    const app = createApp(services({ config: withTranslator, cliProxy: failing(new Error(reason)) }));

    const response = await postJson(app, "/translator/gemini/complete", {
        provider: "gemini",
        redirectUrl: "http://localhost:51121/oauth-callback?code=abc&state=xyz",
        state: "xyz",
    });

    expect(((await response.json()) as { message?: string }).message).toBe(reason);
});

test("reports the named connection attempt's status even when the account list is unchanged", async () => {
    const client = clientFor(
        createApp(
            services({
                config: withTranslator,
                cliProxy: { status: async (provider, state) => ({ status: provider === "codex" && state === "attempt-1" ? "ok" : "wait" }) },
            }),
        ),
    );

    await expect(client.translator.status({ provider: "codex", state: "attempt-1" })).resolves.toEqual({ status: "ok" });
});

test("a disconnect failure says what went wrong instead of Internal server error", async () => {
    const reason = "the translator refused to drop that credential";
    const app = createApp(services({ config: withTranslator, cliProxy: failing(new Error(reason)) }));

    const response = await postJson(app, "/translator/gemini/disconnect", { provider: "gemini", name: "antigravity-user.json" });

    expect(((await response.json()) as { message?: string }).message).toBe(reason);
});

// A Google credential the proxy filed without a project is read as healthy by its own selector, so it keeps catching
// turns that die on it. The account list is the surface it appears on the moment it is connected, which makes it the
// last place it can be caught before a turn finds it.
test("takes a credential that can serve no turn out of the rotation when the account list is read", async () => {
    let benched = 0;
    const client = clientFor(
        createApp(
            services({
                config: withTranslator,
                cliProxy: {
                    benchUnusable: async () => {
                        benched += 1;
                        return ["antigravity-new@example.com.json"];
                    },
                },
            }),
        ),
    );

    await expect(client.translator.accounts()).resolves.toEqual({ codex: [], grok: [], kimi: [], gemini: [] });
    // Fired alongside the read, not awaited by it: the list must not wait on a PATCH to the proxy.
    await vi.waitFor(() => expect(benched).toBe(1));
});

test("a listing failure says so rather than claiming the sandbox has no subscriptions", async () => {
    const client = clientFor(createApp(services({ config: withTranslator, cliProxy: failing(new Error("could not read the credential store")) })));

    await expect(client.translator.accounts()).rejects.toThrow(/credential store/);
});
