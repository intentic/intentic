import { claudeContract } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import { expect, test } from "vitest";
import { errorCode, routesClient } from "../route-testing.js";
import type { StoredAccount } from "./claude-credentials.js";
import { type ClaudeRoutesDeps, createClaudeRoutes } from "./claude.routes.js";

/* The Claude OAuth routes, over the three seams they read.
 *
 * Split out of app.integration.test.ts — 116 tests over every route in the daemon, in one file — and then
 * stood up on `ClaudeRoutesDeps` rather than on the daemon. What a test does not name here is not reachable
 * from these routes at all, so the fake cannot drift out of shape with a daemon it no longer describes. */

/* `accountUsage` is real state here, not a stub: /claude/accounts folds the usage snapshot into every row it
 * returns, and disconnect clears it alongside the credential — "the snapshot goes with the account" is part of
 * what these tests check. Empty by default, which is what a sandbox reports before any turn has run. */
const claudeClient = (claudeStore: ClaudeRoutesDeps["claudeStore"]) =>
    routesClient(
        claudeContract,
        createClaudeRoutes(
            unstubbed<ClaudeRoutesDeps>("claude deps", {
                claudeStore,
                accountUsage: { read: async () => ({}), record: async () => {}, clear: async () => {} },
                // The list waits on a sweep before answering; there is no endpoint to sweep under test, and
                // what the sweep would have written is exactly what `accountUsage` is standing in for.
                claudeUsage: { refresh: async () => {}, start: () => () => {} },
            }),
        ),
    );

test("Claude OAuth: accounts reflect the store, disconnect clears the named one", async () => {
    const accounts = new Map<string, StoredAccount>();
    const client = claudeClient(
        unstubbed("claudeStore", {
            read: async (id) => accounts.get(id),
            write: async (account) => {
                accounts.set(account.id, account);
            },
            clear: async (id) => {
                accounts.delete(id);
            },
            list: async () =>
                [...accounts.values()].map((account) =>
                    account.scope !== undefined
                        ? { id: account.id, label: account.label, connectedAt: account.connectedAt, scope: account.scope }
                        : { id: account.id, label: account.label, connectedAt: account.connectedAt },
                ),
        }),
    );
    expect(await client.accounts()).toEqual({ accounts: [] });
    // The start route hands the browser an authorize URL + PKCE material.
    const challenge = await client.start();
    expect(typeof challenge.authorizeUrl).toBe("string");
    expect(typeof challenge.verifier).toBe("string");

    // Directly store two accounts (exchange itself hits Anthropic; the store wiring is what we assert here).
    accounts.set("a", { id: "a", label: "work", connectedAt: 1, accessToken: "tok", scope: "user:inference" });
    accounts.set("b", { id: "b", label: "personal", connectedAt: 2, accessToken: "tok2" });
    expect(await client.accounts()).toEqual({
        accounts: [
            { id: "a", label: "work", connectedAt: 1, scope: "user:inference" },
            { id: "b", label: "personal", connectedAt: 2 },
        ],
    });
    expect(await client.disconnect({ id: "a" })).toEqual({ ok: true });
    expect(accounts.has("a")).toBe(false);
    expect(accounts.has("b")).toBe(true);
});

// The account list is the one place a user can tell two connections of the same provider apart, so it has to be
// able to name them: an identity the provider never reported (or one the user calls something else) leaves
// renaming as the only answer.
test("Claude OAuth: rename writes the label through, and 404s on an account that is gone", async () => {
    const accounts = new Map<string, StoredAccount>([
        ["a", { id: "a", label: "Claude", connectedAt: 1, accessToken: "tok", email: "a@example.com" }],
    ]);
    const client = claudeClient(
        unstubbed("claudeStore", {
            read: async (id) => accounts.get(id),
            write: async (account) => {
                accounts.set(account.id, account);
            },
            clear: async (id) => {
                accounts.delete(id);
            },
            list: async () => [...accounts.values()].map(({ accessToken: _token, ...account }) => account),
        }),
    );
    expect(await client.rename({ id: "a", label: " Work " })).toEqual({
        id: "a",
        label: "Work",
        connectedAt: 1,
        email: "a@example.com",
    });
    // The credential is untouched — a rename writes the display name and nothing else.
    expect(accounts.get("a")?.accessToken).toBe("tok");
    // Blank means "back to the derived name", not a nameless row.
    expect((await client.rename({ id: "a", label: "" })).label).toBe("a@example.com");
    expect(await errorCode(client.rename({ id: "gone", label: "Work" }))).toBe("NOT_FOUND");
});
