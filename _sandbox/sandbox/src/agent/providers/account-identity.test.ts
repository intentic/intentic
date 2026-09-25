import type { AgentEvent, Automation, OauthAccount } from "@intentic/sandbox-contract";
import { unstubbed } from "@intentic/testing";
import type { Services } from "../../composition.js";
import { services } from "../../harness/route-services.testing.js";
import { beginTurn } from "../../testing.js";
import { mergeSupersededAccounts, sameAccount, signInIdentity } from "./account-identity.js";
import type { AccountDoor } from "./provider-module.js";
import { routingFor } from "./routing.js";

// Who an account is, once for every provider, and what becomes of a duplicate from before a reconnect reused its id.

const row = (id: string, over: Partial<OauthAccount> = {}): OauthAccount => ({ id, label: id, connectedAt: 1, ...over });

test("identity is the email, case-folded, within its organisation and estate; no email is nothing to match", () => {
    expect(signInIdentity({ email: "Me@Example.com", organization: "Org" })).toBe(signInIdentity({ email: "me@example.com", organization: "Org" }));
    expect(signInIdentity({ email: "me@example.com", organization: "Org" })).not.toBe(signInIdentity({ email: "me@example.com", organization: "Other" }));
    expect(signInIdentity({ email: "me@example.com", variant: "intl" })).not.toBe(signInIdentity({ email: "me@example.com", variant: "cn" }));
    expect(signInIdentity({})).toBeUndefined();
    expect(signInIdentity({ email: " " })).toBeUndefined();
});

test("a sign-in lands on the account already on file for its identity, the one waiting for a reconnect first", () => {
    const stored = [row("live", { email: "me@example.com" }), row("revoked", { email: "me@example.com", needsReauth: true }), row("you", { email: "you@example.com" })];
    expect(sameAccount(stored, { email: "ME@example.com" })?.id).toBe("revoked");
    expect(sameAccount(stored, { email: "you@example.com" })?.id).toBe("you");
    expect(sameAccount(stored, { email: "new@example.com" })).toBeUndefined();
    expect(sameAccount(stored, {})).toBeUndefined();
});

// A door over rows held in memory: `forget` drops the row, as every provider's does with its credential.
const memoryDoor = (rows: OauthAccount[]): AccountDoor & { readonly rows: () => readonly string[] } => ({
    ...unstubbed<AccountDoor>("door", {}),
    list: async () => [...rows],
    identityOf: signInIdentity,
    forget: async (id) => {
        rows.splice(
            rows.findIndex((entry) => entry.id === id),
            1,
        );
    },
    rows: () => rows.map((entry) => entry.id),
});

const T0 = 1_700_000_000_000;

// The conversation this suite is about: it last ran on `old`, the row a pre-reuse reconnect left revoked beside `new`.
const pinnedTo = async (deps: Services, conversationId: string, account: string): Promise<void> => {
    await beginTurn(deps.conversations, { conversationId, prompt: "go", isolated: false, profile: { agent: "claude", harness: "native", account }, byPerson: true }, T0);
    const frame: AgentEvent = { kind: "session", sessionId: "s-1", account };
    deps.conversations.send(conversationId, { kind: "frame", frame }, T0);
    await deps.conversations.send(conversationId, { kind: "settle" }, T0).settled;
};

test("a conversation pinned to a superseded id keeps running on the survivor, and so does an automation", async () => {
    const saved: Pick<Automation, "id" | "account">[] = [];
    const deps = services({
        automations: unstubbed<Services["automations"]>("automations", {
            list: async () => [{ id: "nightly", account: "old", runs: [] } as never, { id: "other", account: "lone", runs: [] } as never],
            upsert: async ({ id, account }) => void saved.push({ id, ...(account === undefined ? {} : { account }) }),
        }),
    });
    await pinnedTo(deps, "conv-old", "old");
    await pinnedTo(deps, "conv-lone", "lone");
    const door = memoryDoor([
        row("old", { email: "me@example.com", needsReauth: true, connectedAt: 1 }),
        row("new", { email: "me@example.com", connectedAt: 2 }),
        row("lone", { email: "you@example.com", needsReauth: true, connectedAt: 3 }),
    ]);

    expect(await mergeSupersededAccounts(deps, { claude: door })).toEqual([{ provider: "claude", from: "old", to: "new" }]);

    // Its next turn routes to the survivor: a named account that is gone would have been refused.
    const entry = deps.agents.entry("conv-old");
    expect(entry?.profile.account).toBe("new");
    expect(routingFor(entry?.profile, { agent: "claude" }).account).toBe("new");
    // Same seat, so the session it holds carries on.
    expect(entry?.sessionId).toBe("s-1");
    expect(deps.agents.entry("conv-lone")?.profile.account).toBe("lone");
    expect(saved).toEqual([{ id: "nightly", account: "new" }]);
    expect(door.rows()).toEqual(["new", "lone"]);
    // Idempotent: the next boot finds nothing to merge.
    expect(await mergeSupersededAccounts(deps, { claude: door })).toEqual([]);
});

test("the survivor is a working credential over a revoked one, then the newest sign-in", async () => {
    const deps = { agents: unstubbed<Services["agents"]>("agents", { repointAccount: async () => 0 }), automations: unstubbed<Services["automations"]>("automations", { list: async () => [] }) };
    const both = memoryDoor([row("older", { email: "me@example.com", connectedAt: 1 }), row("newer", { email: "me@example.com", connectedAt: 2 })]);
    expect(await mergeSupersededAccounts(deps, { cursor: both })).toEqual([{ provider: "cursor", from: "older", to: "newer" }]);
    const revokedNewest = memoryDoor([row("working", { email: "me@example.com", connectedAt: 1 }), row("dead", { email: "me@example.com", connectedAt: 2, needsReauth: true })]);
    expect(await mergeSupersededAccounts(deps, { cursor: revokedNewest })).toEqual([{ provider: "cursor", from: "dead", to: "working" }]);
    // Rows naming no identity are never merged, however alike their labels.
    const anonymous = memoryDoor([row("a"), row("b")]);
    expect(await mergeSupersededAccounts(deps, { meta: anonymous })).toEqual([]);
});
