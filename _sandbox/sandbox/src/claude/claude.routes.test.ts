import { claudeContract } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import { expect, test } from "vitest";
import { errorCode, routesClient } from "../route-testing.js";
import type { StoredAccount } from "./claude-credentials.js";
import type { SeatRefusal } from "./claude-seats.js";
import { type ClaudeRoutesDeps, createClaudeRoutes } from "./claude.routes.js";

/* The Claude OAuth routes, over the three seams they read.
 *
 * Split out of app.integration.test.ts — 116 tests over every route in the daemon, in one file — and then
 * stood up on `ClaudeRoutesDeps` rather than on the daemon. What a test does not name here is not reachable
 * from these routes at all, so the fake cannot drift out of shape with a daemon it no longer describes. */

/* `accountUsage` is real state here, not a stub: /claude/accounts folds the usage snapshot into every row it
 * returns, and disconnect clears it alongside the credential — "the snapshot goes with the account" is part of
 * what these tests check. Empty by default, which is what a sandbox reports before any turn has run. */
const claudeClient = (
    claudeStore: ClaudeRoutesDeps["claudeStore"],
    sweeps: { withinMs: number | undefined; force: boolean | undefined }[] = [],
    // Real state for the same reason accountUsage is: the row an organization has turned away says so, and
    // disconnect forgets that alongside the credential.
    seats = new Map<string, SeatRefusal>(),
) =>
    routesClient(
        claudeContract,
        createClaudeRoutes(
            unstubbed<ClaudeRoutesDeps>("claude deps", {
                claudeStore,
                accountUsage: { read: async () => ({}), record: async () => {}, clear: async () => {} },
                claudeSeats: {
                    read: async () => Object.fromEntries(seats),
                    refuse: async (id, reason) => {
                        seats.set(id, { at: 1, reason });
                    },
                    clear: async (id) => {
                        seats.delete(id);
                    },
                },
                // The list waits on a sweep before answering; there is no endpoint to sweep under test, and
                // what the sweep would have written is exactly what `accountUsage` is standing in for. What it
                // was ASKED for is recorded, because the freshness the caller demanded is itself a route
                // decision — see the forced-read test.
                claudeUsage: {
                    refresh: async (withinMs, force) => {
                        sweeps.push({ withinMs, force });
                    },
                    start: () => () => {},
                },
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
    expect(await client.accounts({})).toEqual({ accounts: [] });
    // The start route hands the browser an authorize URL + PKCE material.
    const challenge = await client.start();
    expect(typeof challenge.authorizeUrl).toBe("string");
    expect(typeof challenge.verifier).toBe("string");

    // Directly store two accounts (exchange itself hits Anthropic; the store wiring is what we assert here).
    accounts.set("a", { id: "a", label: "work", connectedAt: 1, accessToken: "tok", scope: "user:inference" });
    accounts.set("b", { id: "b", label: "personal", connectedAt: 2, accessToken: "tok2" });
    expect(await client.accounts({})).toEqual({
        accounts: [
            { id: "a", label: "work", connectedAt: 1, scope: "user:inference" },
            { id: "b", label: "personal", connectedAt: 2 },
        ],
    });
    expect(await client.disconnect({ id: "a" })).toEqual({ ok: true });
    expect(accounts.has("a")).toBe(false);
    expect(accounts.has("b")).toBe(true);
});

/* THE ROW FOR AN ACCOUNT THAT SIGNS IN AND STILL CANNOT RUN A TURN. Its organization has Claude Code switched
 * off: the credential is in perfect health, so the reconnect badge every other bad-account state raises would
 * send the user through a sign-in that works and changes nothing. The provider's own sentence instead, which is
 * the only text that names what an admin has to switch back on — and a revoked credential outranks it, because
 * that one really is fixed by reconnecting. */
test("Claude OAuth: an account its organization turned away says so without asking for a reconnect", async () => {
    const refusal = "Your organization has disabled Claude subscription access for Claude Code";
    const accounts = new Map<string, StoredAccount>([
        ["a", { id: "a", label: "Work", connectedAt: 1, accessToken: "tok" }],
        ["b", { id: "b", label: "Old", connectedAt: 2, accessToken: "tok", revokedAt: 5, revokedReason: "Signed out" }],
    ]);
    const seats = new Map<string, SeatRefusal>([
        ["a", { at: 1, reason: refusal }],
        ["b", { at: 1, reason: refusal }],
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
            list: async () =>
                [...accounts.values()].map((account) =>
                    account.revokedAt === undefined
                        ? { id: account.id, label: account.label, connectedAt: account.connectedAt }
                        : { id: account.id, label: account.label, connectedAt: account.connectedAt, needsReauth: true, detail: "Signed out" },
                ),
        }),
        [],
        seats,
    );
    expect(await client.accounts({})).toEqual({
        accounts: [
            { id: "a", label: "Work", connectedAt: 1, detail: refusal },
            { id: "b", label: "Old", connectedAt: 2, needsReauth: true, detail: "Signed out" },
        ],
    });
    // The rename response REPLACES the row on the card, so it has to carry the note too — renaming an account is
    // not the moment to quietly drop the reason it has been benched.
    expect(await client.rename({ id: "a", label: "Job" })).toEqual({ id: "a", label: "Job", connectedAt: 1, detail: refusal });
    // And disconnecting forgets it: a reconnect mints a fresh account id, so an entry left behind is orphaned.
    await client.disconnect({ id: "a" });
    expect(seats.has("a")).toBe(false);
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

/* A reading a caller cannot doubt is a reading nobody can act on. Every ordinary read of this list wants the
 * daemon's freshness bound — it is what keeps a page load off the provider's quota endpoint — but the person who
 * has just changed something about the account (a seat downgraded, a plan swapped, a limit spent on another
 * machine) is asking exactly whether the number they can see survived it, and an answer from the last minute
 * cannot tell them. So `force` goes through to the sweep, and it waits longer for it: there is a spinner on the
 * other end of this one, and giving up early would hand back the very reading it was pressed to go behind. */
test("Claude OAuth: a forced account list re-measures, and waits longer for it", async () => {
    const sweeps: { withinMs: number | undefined; force: boolean | undefined }[] = [];
    const client = claudeClient(
        unstubbed("claudeStore", {
            read: async () => undefined,
            write: async () => {},
            clear: async () => {},
            list: async () => [],
        }),
        sweeps,
    );
    await client.accounts({});
    await client.accounts({ force: "1" });
    expect(sweeps.map((sweep) => sweep.force)).toEqual([false, true]);
    expect(sweeps[1]!.withinMs).toBeGreaterThan(sweeps[0]!.withinMs!);
});
