import { unstubbed } from "@intentic/testing";
import { expect, test } from "vitest";
import { type ClaudeAccountDeps, claudeAccountDoor } from "./claude-accounts.js";
import { displayLabel, type StoredAccount } from "./claude-credentials.js";
import type { SeatRefusal } from "./claude-seats.js";

/* Claude's account door, over the three seams it reads. Stood up on `ClaudeAccountDeps` rather than on the
 * daemon: what a test does not name here is not reachable from the door at all, so the fake cannot drift out
 * of shape with a daemon it no longer describes. The route family over every door has its own test
 * (agent/accounts.routes.test.ts); this one is about what THIS door answers. */

/* `accountUsage` is real state here, not a stub: the list folds the usage snapshot into every row it returns,
 * and disconnect clears it alongside the credential: "the snapshot goes with the account" is part of what these
 * tests check. Empty by default, which is what a sandbox reports before any turn has run. */
const door = (
    claudeStore: ClaudeAccountDeps["claudeStore"],
    sweeps: { withinMs: number | undefined; maxAgeMs: number | undefined }[] = [],
    // Real state for the same reason accountUsage is: the row an organization has turned away says so, and
    // disconnect forgets that alongside the credential.
    seats = new Map<string, SeatRefusal>(),
) =>
    claudeAccountDoor(
        unstubbed<ClaudeAccountDeps>("claude deps", {
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
            // The list waits on a sweep before answering; there is no endpoint to sweep under test, and what
            // the sweep would have written is exactly what `accountUsage` is standing in for. What it was
            // ASKED for is recorded, because the freshness the caller demanded is itself a decision of the
            // door's: see the forced-read test.
            headroom: {
                refresh: async (options) => {
                    sweeps.push({ withinMs: options?.withinMs, maxAgeMs: options?.maxAgeMs });
                },
                record: async () => {},
                clear: async () => {},
                read: async () => ({}),
                onChange: () => () => {},
                start: () => () => {},
            },
        }),
    );

const memoryStore = (accounts: Map<string, StoredAccount>): ClaudeAccountDeps["claudeStore"] =>
    unstubbed("claudeStore", {
        read: async (id) => accounts.get(id),
        write: async (account) => {
            accounts.set(account.id, account);
        },
        clear: async (id) => {
            accounts.delete(id);
        },
        list: async () => [...accounts.values()].map(({ accessToken: _token, ...account }) => ({ ...account, label: displayLabel(account) })),
    });

test("Claude: the list reflects the store, a start keeps its proof here, disconnect clears the named account", async () => {
    const accounts = new Map<string, StoredAccount>();
    const claude = door(memoryStore(accounts));
    expect(await claude.list(false)).toEqual([]);
    // A start hands the browser a page and a handshake, and NOTHING redeemable: the verifier stays in the door.
    const started = await claude.start(undefined);
    expect(started.url).toContain("code_challenge=");
    expect(started.flow).toBe("paste");
    expect(started.handshake).not.toBe("");
    expect(JSON.stringify(started)).not.toContain("verifier");
    // A code brought back for an attempt the door never started (or one that expired) is refused before any
    // exchange is attempted, in a sentence that says what to do.
    await expect(claude.complete!({ handshake: "not-ours", code: "abc#def" })).rejects.toThrow(/start the connection again/);
    // A cancelled attempt is forgotten the same way.
    claude.cancel(started.handshake);
    await expect(claude.complete!({ handshake: started.handshake, code: "abc#def" })).rejects.toThrow(/start the connection again/);

    // Directly store two accounts (the exchange itself hits Anthropic; the store wiring is what is asserted).
    accounts.set("a", { id: "a", label: "work", connectedAt: 1, accessToken: "tok", scope: "user:inference" });
    accounts.set("b", { id: "b", label: "personal", connectedAt: 2, accessToken: "tok2" });
    expect(await claude.list(false)).toEqual([
        { id: "a", label: "work", connectedAt: 1, scope: "user:inference" },
        { id: "b", label: "personal", connectedAt: 2 },
    ]);
    await claude.disconnect("a");
    expect(accounts.has("a")).toBe(false);
    expect(accounts.has("b")).toBe(true);
});

/* THE ROW FOR AN ACCOUNT THAT SIGNS IN AND STILL CANNOT RUN A TURN. Its organization has Claude Code switched
 * off: the credential is in perfect health, so the reconnect badge every other bad-account state raises would
 * send the user through a sign-in that works and changes nothing. The provider's own sentence instead, which is
 * the only text that names what an admin has to switch back on, and a revoked credential outranks it, because
 * that one really is fixed by reconnecting. */
test("Claude: an account its organization turned away says so without asking for a reconnect", async () => {
    const refusal = "Your organization has disabled Claude subscription access for Claude Code";
    const accounts = new Map<string, StoredAccount>([
        ["a", { id: "a", label: "Work", connectedAt: 1, accessToken: "tok" }],
        ["b", { id: "b", label: "Old", connectedAt: 2, accessToken: "tok", revokedAt: 5, revokedReason: "Signed out" }],
    ]);
    const seats = new Map<string, SeatRefusal>([
        ["a", { at: 1, reason: refusal }],
        ["b", { at: 1, reason: refusal }],
    ]);
    const claude = door(
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
                        ? { id: account.id, label: displayLabel(account), connectedAt: account.connectedAt }
                        : { id: account.id, label: displayLabel(account), connectedAt: account.connectedAt, needsReauth: true, detail: "Signed out" },
                ),
        }),
        [],
        seats,
    );
    expect(await claude.list(false)).toEqual([
        { id: "a", label: "Work", connectedAt: 1, detail: refusal },
        { id: "b", label: "Old", connectedAt: 2, needsReauth: true, detail: "Signed out" },
    ]);
    // The rename answer REPLACES the row on the card, so it has to carry the note too: renaming an account is
    // not the moment to quietly drop the reason it has been benched.
    expect(await claude.rename("a", "Job")).toEqual({ id: "a", label: "Job", connectedAt: 1, detail: refusal });
    // And disconnecting forgets it: a reconnect mints a fresh account id, so an entry left behind is orphaned.
    await claude.disconnect("a");
    expect(seats.has("a")).toBe(false);
});

// The account list is the one place a user can tell two connections of the same provider apart, so it has to be
// able to name them: an identity the provider never reported (or one the user calls something else) leaves
// renaming as the only answer.
test("Claude: rename writes the label through, blank restores the derived name, and a gone account is undefined", async () => {
    const accounts = new Map<string, StoredAccount>([["a", { id: "a", label: "Claude", connectedAt: 1, accessToken: "tok", email: "a@example.com" }]]);
    const claude = door(memoryStore(accounts));
    expect(await claude.rename("a", " Work ")).toEqual({ id: "a", label: "Work", connectedAt: 1, email: "a@example.com" });
    // The credential is untouched: a rename writes the display name and nothing else.
    expect(accounts.get("a")?.accessToken).toBe("tok");
    expect((await claude.rename("a", ""))?.label).toBe("a@example.com");
    expect(await claude.rename("gone", "Work")).toBeUndefined();
});

/* A reading a caller cannot doubt is a reading nobody can act on. Every ordinary read of this list wants the
 * daemon's freshness bound: it is what keeps a page load off the provider's quota endpoint, but the person who
 * has just changed something about the account (a seat downgraded, a plan swapped, a limit spent on another
 * machine) is asking exactly whether the number they can see survived it, and an answer from the last minute
 * cannot tell them. So `force` goes through to the sweep, and it waits longer for it: there is a spinner on the
 * other end of this one, and giving up early would hand back the very reading it was pressed to go behind. */
test("Claude: a forced list re-measures, and waits longer for it", async () => {
    const sweeps: { withinMs: number | undefined; maxAgeMs: number | undefined }[] = [];
    const claude = door(memoryStore(new Map()), sweeps);
    await claude.list(false);
    await claude.list(true);
    // Unforced, the service's own freshness bound applies; forced, a reading from a moment ago is re-taken.
    expect(sweeps.map((sweep) => sweep.maxAgeMs)).toEqual([undefined, 0]);
    expect(sweeps[1]!.withinMs).toBeGreaterThan(sweeps[0]!.withinMs!);
});
