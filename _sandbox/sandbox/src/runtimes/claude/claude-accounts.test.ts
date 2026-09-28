import { unstubbed } from "@intentic/testing";
import pino from "pino";
import { mergeSupersededAccounts } from "../../agent/providers/accounts/account-identity.js";
import type { Services } from "../../composition.js";
import { CATCHING_DEVICE, catchingServicesHubs, fakeCatcher } from "../../agent/providers/accounts/loopback-bridge.testing.js";
import { type ClaudeAccountDeps, claudeAccountDoor } from "./claude-accounts.js";
import { displayLabel, type StoredAccount } from "./claude-credentials.js";
import type { SeatRefusal } from "./claude-seats.js";

// Claude's account door, built on ClaudeAccountDeps rather than the daemon, so a fake cannot drift from a daemon it no
// longer describes. Route-family behavior lives in agent/accounts.routes.test.ts.

// accountUsage is real state, not a stub: list folds it into every row, and disconnect clears it with the credential.
// Empty by default, matching a sandbox before any turn runs.
// What forgetting an account also clears, empty here: this suite is about the credential and the seat.
const NO_REFUSALS: ClaudeAccountDeps["providerRefusals"] = { read: async () => ({}), record: async () => {}, clear: async () => {}, onChange: () => () => {} };
const NO_OBSERVED: ClaudeAccountDeps["observedLimits"] = { spent: async () => ({}), record: async () => {}, clear: async () => {} };

const door = (
    claudeStore: ClaudeAccountDeps["claudeStore"],
    sweeps: { withinMs: number | undefined; maxAgeMs: number | undefined; watched: boolean | undefined }[] = [],
    // Real state like accountUsage: tracks the org's turn-away row, and disconnect forgets it with the credential.
    seats = new Map<string, SeatRefusal>(),
    // Every re-test of a marked account the door asked for; the provider is never re-asked here (claude-seat-check.test.ts).
    rechecks: [string, { readonly force?: boolean } | undefined][] = [],
    // How many times the door dropped the cached model list; the catalog itself is claude-models' suite.
    catalog = { forgets: 0 },
    // The owner's devices; none by default, so a sign-in is the paste.
    hostHub: ClaudeAccountDeps["hostHub"] = catchingServicesHubs({}).hostHub,
) =>
    claudeAccountDoor(
        unstubbed<ClaudeAccountDeps>("claude deps", {
            claudeStore,
            claudeModels: unstubbed<ClaudeAccountDeps["claudeModels"]>("claudeModels", {
                forget: () => {
                    catalog.forgets += 1;
                },
            }),
            claudeSeatCheck: {
                recheck: async (id, options) => {
                    rechecks.push([id, options]);
                    return false;
                },
            },
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
            providerRefusals: NO_REFUSALS,
            observedLimits: NO_OBSERVED,
            // Nothing of the owner's is connected: every sign-in here is the paste (the bridge has its own suite).
            hostHub,
            logger: pino({ level: "silent" }),
            webextHub: catchingServicesHubs({}).webextHub,
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
    await claude.forget("a");
    expect(accounts.has("a")).toBe(false);
    expect(accounts.has("b")).toBe(true);
});

// The model list is cached for an hour and does not know which credential it was asked with. A sandbox whose picker
// opened before its first sign-in was served the token-less answer (the CLI's one versioned model, Fable) for the rest
// of that hour after connecting, so both ends of an account's life drop it.
test("Claude: connecting an account, and disconnecting one, drops the cached model list", async () => {
    const accounts = new Map<string, StoredAccount>();
    const catalog = { forgets: 0 };
    const claude = door(memoryStore(accounts), [], new Map(), [], catalog);
    // The exchange is Anthropic's token endpoint; answered here so the sign-in lands in the store.
    const exchange = jest
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(JSON.stringify({ access_token: "tok-new", refresh_token: "refresh-new", expires_in: 3600 })));
    try {
        const started = await claude.start(undefined);
        await claude.complete!({ handshake: started.handshake, code: `abc#${started.handshake}` });
    } finally {
        exchange.mockRestore();
    }

    expect(accounts.size).toBe(1);
    expect(catalog.forgets).toBe(1);

    await claude.forget([...accounts.keys()][0]!);
    expect(accounts.size).toBe(0);
    expect(catalog.forgets).toBe(2);
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
    // Forgetting clears the seat entry with the credential, so nothing is left to orphan.
    await claude.forget("a");
    expect(seats.has("a")).toBe(false);
});

// The row is where a person looks for access coming back, and no turn runs on a marked account to find it.
test("Claude: the list re-tests each marked account, at once when a person presses re-measure", async () => {
    const accounts = new Map<string, StoredAccount>([
        ["a", { id: "a", label: "Work", connectedAt: 1, accessToken: "tok" }],
        ["b", { id: "b", label: "Home", connectedAt: 2, accessToken: "tok2" }],
    ]);
    const rechecks: [string, { readonly force?: boolean } | undefined][] = [];
    const claude = door(memoryStore(accounts), [], new Map([["a", { at: 1, reason: "Your organization has disabled Claude Code." }]]), rechecks);

    await claude.list(false);
    await claude.list(true);

    expect(rechecks).toEqual([
        ["a", { force: false }],
        ["a", { force: true }],
    ]);
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
            return await claude.complete!({ handshake: started.handshake, code: `abc#${started.handshake}` });
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

// Before reconnects landed in place, a reconnect left the revoked row behind next to the new one. Reading the list never
// deletes it: the boot merge does (account-identity.ts), after moving every conversation and automation pinned to it
// onto the row that goes on. A revoked row nobody replaced still asks for its reconnect.
test("Claude: a revoked account the same person has since reconnected under a new row is merged into it, never by a read", async () => {
    const accounts = new Map<string, StoredAccount>([
        ["old", { id: "old", connectedAt: 1, accessToken: "dead", email: "me@example.com", organization: "Org", revokedAt: 5 }],
        ["new", { id: "new", connectedAt: 2, accessToken: "tok", email: "Me@Example.com", organization: "Org" }],
        ["lone", { id: "lone", connectedAt: 3, accessToken: "dead", email: "you@example.com", organization: "Org", revokedAt: 5 }],
    ]);
    const claude = door(memoryStore(accounts));
    expect((await claude.list(false)).map((account) => account.id)).toEqual(["old", "new", "lone"]);
    const moved: string[] = [];
    const merged = await mergeSupersededAccounts(
        {
            agents: unstubbed<Services["agents"]>("agents", {
                repointAccount: async (from, to) => {
                    moved.push(`${from}->${to}`);
                    return 1;
                },
            }),
            automations: unstubbed<Services["automations"]>("automations", { list: async () => [] }),
        },
        { claude },
    );
    expect(merged).toEqual([{ provider: "claude", from: "old", to: "new" }]);
    expect(moved).toEqual(["old->new"]);
    expect([...accounts.keys()]).toEqual(["new", "lone"]);
});

// A device of the owner's that watches loopback turns the sign-in into Claude Code's own: Anthropic sends the browser to
// localhost on that machine, the landing comes back up the device's stream, and the door finishes it with nobody
// pasting, naming the same redirect in the exchange as in the authorize URL.
test("Claude: with a device watching, the sign-in redirects to loopback and finishes from the caught landing", async () => {
    const accounts = new Map<string, StoredAccount>();
    const rog = fakeCatcher();
    const claude = door(memoryStore(accounts), [], new Map(), [], { forgets: 0 }, catchingServicesHubs({ rog: { facts: CATCHING_DEVICE, catcher: rog } }).hostHub);
    const exchange = jest
        .spyOn(globalThis, "fetch")
        .mockResolvedValue(new Response(JSON.stringify({ access_token: "tok-caught", refresh_token: "r", expires_in: 3600 })));
    try {
        const started = await claude.start(undefined);
        expect(started.flow).toBe("redirect");
        expect(started.state).toBe(started.handshake);
        expect(started.catchers).toEqual([{ kind: "device", label: "rog" }]);
        const redirect = new URL(started.url).searchParams.get("redirect_uri");
        expect(redirect).toBe(`http://localhost:${rog.asked[0]?.port}/callback`);
        expect(rog.asked[0]?.port).toBeGreaterThanOrEqual(49_152);
        expect(claude.status!(started.handshake)).toEqual({ status: "wait" });
        // A pasted address from some other attempt is refused before it reaches Anthropic.
        await expect(claude.complete!({ handshake: started.handshake, redirectUrl: `${redirect}?code=x&state=other` })).rejects.toThrow(/different sign-in/);

        await new Promise((resolve) => setTimeout(resolve, 5));
        rog.push({ type: "landed", url: `${redirect}?code=caught-code&state=${started.handshake}` });
        await new Promise((resolve) => setTimeout(resolve, 20));

        expect(exchange.mock.calls.map(([, init]) => JSON.parse(String(init?.body)))).toEqual([
            expect.objectContaining({ grant_type: "authorization_code", code: "caught-code", state: started.handshake, redirect_uri: redirect }),
        ]);
        expect(accounts.size).toBe(1);
        expect(claude.status!(started.handshake)).toMatchObject({ status: "ok", account: { id: [...accounts.keys()][0] } });
        // The same grant pasted afterwards finds the attempt gone rather than redeeming it twice.
        await expect(claude.complete!({ handshake: started.handshake, redirectUrl: `${redirect}?code=caught-code&state=${started.handshake}` })).rejects.toThrow(
            /start the connection again/,
        );
    } finally {
        exchange.mockRestore();
    }
});
