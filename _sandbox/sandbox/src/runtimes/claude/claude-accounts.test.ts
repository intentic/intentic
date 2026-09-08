import { unstubbed } from "@intentic/testing";
import { expect, test } from "vitest";
import { type ClaudeAccountDeps, claudeAccountDoor } from "./claude-accounts.js";
import { displayLabel, type StoredAccount } from "./claude-credentials.js";
import type { SeatRefusal } from "./claude-seats.js";

// Claude's account door, built on ClaudeAccountDeps rather than the daemon, so a fake cannot drift from a daemon it no
// longer describes. Route-family behavior lives in agent/accounts.routes.test.ts.

// accountUsage is real state, not a stub: list folds it into every row, and disconnect clears it with the credential.
// Empty by default, matching a sandbox before any turn runs.
const door = (
    claudeStore: ClaudeAccountDeps["claudeStore"],
    sweeps: { withinMs: number | undefined; maxAgeMs: number | undefined }[] = [],
    // Real state like accountUsage: tracks the org's turn-away row, and disconnect forgets it with the credential.
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
            // Records what refresh was asked for (withinMs/maxAgeMs); there is no real sweep to run under test.
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
    const started = await claude.start(undefined);
    expect(started.url).toContain("code_challenge=");
    expect(started.flow).toBe("paste");
    expect(started.handshake).not.toBe("");
    expect(JSON.stringify(started)).not.toContain("verifier");
    await expect(claude.complete!({ handshake: "not-ours", code: "abc#def" })).rejects.toThrow(/start the connection again/);
    claude.cancel(started.handshake);
    await expect(claude.complete!({ handshake: started.handshake, code: "abc#def" })).rejects.toThrow(/start the connection again/);

    // Accounts set directly; the exchange itself hits Anthropic, only the store wiring is under test.
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

// An org-disabled account shows the provider's refusal instead of a reconnect prompt, since the credential itself is
// healthy. A revoked credential still outranks the org message, since that one really is fixed by reconnecting.
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
    // Rename replaces the whole row; the refusal detail must survive it too.
    expect(await claude.rename("a", "Job")).toEqual({ id: "a", label: "Job", connectedAt: 1, detail: refusal });
    // Disconnect clears the seat entry; a reconnect mints a new account id, so a leftover entry is orphaned.
    await claude.disconnect("a");
    expect(seats.has("a")).toBe(false);
});

test("Claude: rename writes the label through, blank restores the derived name, and a gone account is undefined", async () => {
    const accounts = new Map<string, StoredAccount>([["a", { id: "a", label: "Claude", connectedAt: 1, accessToken: "tok", email: "a@example.com" }]]);
    const claude = door(memoryStore(accounts));
    expect(await claude.rename("a", " Work ")).toEqual({ id: "a", label: "Work", connectedAt: 1, email: "a@example.com" });
    // Rename must not touch the credential, only the label.
    expect(accounts.get("a")?.accessToken).toBe("tok");
    expect((await claude.rename("a", ""))?.label).toBe("a@example.com");
    expect(await claude.rename("gone", "Work")).toBeUndefined();
});

test("Claude: a forced list re-measures, and waits longer for it", async () => {
    const sweeps: { withinMs: number | undefined; maxAgeMs: number | undefined }[] = [];
    const claude = door(memoryStore(new Map()), sweeps);
    await claude.list(false);
    await claude.list(true);
    // maxAgeMs undefined applies the service's own freshness bound; 0 forces a fresh read.
    expect(sweeps.map((sweep) => sweep.maxAgeMs)).toEqual([undefined, 0]);
    expect(sweeps[1]!.withinMs).toBeGreaterThan(sweeps[0]!.withinMs!);
});
