import { KEYRING_NAME_RE } from "./keyring.js";
import { ConnectionEnvelopeSchema, hubEntryName, hubHostOf, isHubEntryName, wantOfItem, withoutHubEntries } from "./connection-hub.js";

// A hub entry is found by its host and kept apart from the copies an agent spends, so these rules are what makes a saved
// connection reachable from another sandbox and unreachable as a raw value.

test("a connector's card is asked for by its connector alone; a tool server or endpoint by its kind", () => {
    const github = { type: "card", id: "github", kind: "cli", connector: "github", config: { provider: "github", token: "t" } } as const;
    expect(hubHostOf(wantOfItem(github))).toBe("github.cli.connections.invalid");
    expect(hubHostOf({ type: "card", kind: "cli", connector: "cloudflare" })).not.toBe(hubHostOf(wantOfItem(github)));
    expect(hubHostOf(wantOfItem({ type: "card", id: "notion", kind: "mcp", config: { url: "https://mcp.notion.com" } }))).toBe("mcp.connections.invalid");
    expect(hubHostOf({ type: "account", provider: "cursor" })).toBe("cursor.account.connections.invalid");
});

test("an entry name is a keyring name that says what it holds, and only those are the hub's", () => {
    const name = hubEntryName({ type: "card", id: "gh", kind: "cli", connector: "git-hub", config: {} }, "a1f3");
    expect(name).toBe("CONNECTION_GIT_HUB_A1F3");
    expect(KEYRING_NAME_RE.test(name)).toBe(true);
    expect(isHubEntryName(name)).toBe(true);
    expect(withoutHubEntries({ [name]: "{}", VPN_PASSWORD: "x" })).toEqual({ VPN_PASSWORD: "x" });
});

test("an envelope with a field this build does not know is refused rather than half read", () => {
    const envelope = { intentic: "connection", v: 1, label: "Cursor", from: { sandbox: "dev", at: 1 }, item: { type: "account", provider: "cursor", account: { apiKey: "k" } } };
    expect(ConnectionEnvelopeSchema.safeParse(envelope).success).toBe(true);
    expect(ConnectionEnvelopeSchema.safeParse({ ...envelope, extra: true }).success).toBe(false);
    expect(ConnectionEnvelopeSchema.safeParse({ ...envelope, item: { ...envelope.item, provider: "claude" } }).success).toBe(false);
});
