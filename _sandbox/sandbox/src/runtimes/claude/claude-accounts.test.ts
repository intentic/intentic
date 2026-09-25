import { unstubbed } from "@intentic/testing";
import { type ClaudeAccountDeps, claudeAccountDoor } from "./claude-accounts.js";
import { displayLabel, type StoredAccount } from "./claude-credentials.js";
import type { SeatRefusal } from "./claude-seats.js";

// Claude's account door, built on ClaudeAccountDeps rather than the daemon, so a fake cannot drift from a daemon it no
// longer describes. Route-family behavior lives in agent/accounts.routes.test.ts.

// accountUsage is real state, not a stub: list folds it into every row, and disconnect clears it with the credential.
// Empty by default, matching a sandbox before any turn runs.
const door = (
    claudeStore: ClaudeAccountDeps["claudeStore"],
    sweeps: { withinMs: number | undefined; maxAgeMs: number | undefined; watched: boolean | undefined }[] = [],
    // Real state like accountUsage: tracks the org's turn-away row, and disconnect forgets it with the credential.
    seats = new Map<string, SeatRefusal>(),
) =>
    claudeAccountDoor(
        unstubbed<ClaudeAccountDeps>("claude deps", {
            claudeStore,
            accountUsage: { read: async () => ({}), record: async () => {}, markUnread: async () => undefined, clear: async () => {} },
            claudeSeats: {
                read: async () => Object.fromEntries(seats),
                refuse: async (id, reason) => {
                    seats.set(id, { at: 1, reason });
                },
                clear: async (id) => {
                    seats.delete(id);
                },
            },
            // Records what refresh was asked for (withinMs/maxAgeMs/watched); there is no real sweep to run under test.
            headroom: {
                refresh: async (options) => {
                    sweeps.push({ withinMs: options?.withinMs, maxAgeMs: options?.maxAgeMs, watched: options?.watched });
                },
                held: () => [],
                parked: async () => false,
                park: async () => {},
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
        list: async () =>
            [...accounts.values()].map(({ accessToken: _token, revokedAt, revokedReason: _reason, ...account }) => ({
                ...account,
                label: displayLabel(account),
                ...(revokedAt === undefined ? {} : { needsReauth: true }),
            })),
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
// healthy. Both marks ride on a revoked row; which one wins (the revoke, since reconnecting really fixes it) is the
// serviceability rule's call, in the `state` the account route adds.
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
        { id: "a", label: "Work", connectedAt: 1, seatRefusal: refusal },
        { id: "b", label: "Old", connectedAt: 2, needsReauth: true, detail: "Signed out", seatRefusal: refusal },
    ]);
    // Rename replaces the whole row; the seat refusal must survive it too.
    expect(await claude.rename("a", "Job")).toEqual({ id: "a", label: "Job", connectedAt: 1, seatRefusal: refusal });
    // Disconnect clears the seat entry; a later sign-in as this identity mints a new account id, so a leftover entry is orphaned.
    await claude.disconnect("a");
    expect(seats.has("a")).toBe(false);
});

test("Claude: rename writes the label through, blank restores the derived name, and a gone account is undefined", async () => {
    const accounts = new Map<string, StoredAccount>([
        ["a", { id: "a", label: "Claude", connectedAt: 1, accessToken: "tok", email: "a@example.com" }],
    ]);
    const claude = door(memoryStore(accounts));
    expect(await claude.rename("a", " Work ")).toEqual({ id: "a", label: "Work", connectedAt: 1, email: "a@example.com" });
    // Rename must not touch the credential, only the label.
    expect(accounts.get("a")?.accessToken).toBe("tok");
    expect((await claude.rename("a", ""))?.label).toBe("a@example.com");
    expect(await claude.rename("gone", "Work")).toBeUndefined();
});

test("Claude: a forced list re-measures, and waits longer for it", async () => {
    const sweeps: { withinMs: number | undefined; maxAgeMs: number | undefined; watched: boolean | undefined }[] = [];
    const claude = door(memoryStore(new Map()), sweeps);
    await claude.list(false);
    await claude.list(true);
    // maxAgeMs undefined applies the service's own freshness bound; 0 forces a fresh read.
    expect(sweeps.map((sweep) => sweep.maxAgeMs)).toEqual([undefined, 0]);
    // Only the forced list is watched: that flag, not the zero, is what lets a sweep spend a target's read budget early.
    expect(sweeps.map((sweep) => sweep.watched)).toEqual([undefined, true]);
    expect(sweeps[1]!.withinMs).toBeGreaterThan(sweeps[0]!.withinMs!);
});

// Reconnect and "add another" are one sign-in, so whose account came back decides it: the same person and organization
// land on the row already on file, keeping its id (and every chat pinned to it), while anyone else gets a row of their own.
test("Claude: signing in as an account already on file reconnects it in place instead of adding a second row", async () => {
    const accounts = new Map<string, StoredAccount>([
        [
            "old",
            {
                id: "old",
                label: "Mine",
                connectedAt: 1,
                accessToken: "dead",
                refreshToken: "dead-refresh",
                email: "me@example.com",
                organization: "Me's Organization",
                revokedAt: 5,
                revokedReason: "Claude sign-in was revoked, reconnect to keep using this account.",
            },
        ],
    ]);
    const claude = door(memoryStore(accounts));
    const signIn = async (email: string, organization: string) => {
        const realFetch = globalThis.fetch;
        globalThis.fetch = (async () =>
            Response.json({ access_token: `tok-${email}-${organization}`, refresh_token: "fresh", expires_in: 3600, account: { email_address: email }, organization: { name: organization } })) as unknown as typeof fetch;
        try {
            const started = await claude.start(undefined);
            return await claude.complete!({ handshake: started.handshake, code: "abc#def" });
        } finally {
            globalThis.fetch = realFetch;
        }
    };

    const reconnected = await signIn("me@example.com", "Me's Organization");
    expect(reconnected).toEqual({ id: "old", label: "Mine", connectedAt: 1, email: "me@example.com", organization: "Me's Organization" });
    expect(accounts.size).toBe(1);
    expect(accounts.get("old")).toMatchObject({ accessToken: "tok-me@example.com-Me's Organization", refreshToken: "fresh" });
    expect(accounts.get("old")?.revokedAt).toBeUndefined();

    // Same email in another organization is another seat; another email is another person.
    expect((await signIn("me@example.com", "Work"))?.id).not.toBe("old");
    expect((await signIn("you@example.com", "Me's Organization"))?.id).not.toBe("old");
    expect(accounts.size).toBe(3);
});

// Before reconnects landed in place, a reconnect left the revoked row behind next to the new one. The list retires such
// a leftover; a revoked row nobody replaced still asks for its reconnect.
test("Claude: a revoked account the same person has since reconnected under a new row is retired", async () => {
    const accounts = new Map<string, StoredAccount>([
        ["old", { id: "old", connectedAt: 1, accessToken: "dead", email: "me@example.com", organization: "Org", revokedAt: 5 }],
        ["new", { id: "new", connectedAt: 2, accessToken: "tok", email: "me@example.com", organization: "Org" }],
        ["lone", { id: "lone", connectedAt: 3, accessToken: "dead", email: "you@example.com", organization: "Org", revokedAt: 5 }],
    ]);
    const claude = door(memoryStore(accounts));
    expect((await claude.list(false)).map((account) => account.id)).toEqual(["new", "lone"]);
    expect([...accounts.keys()]).toEqual(["new", "lone"]);
});
