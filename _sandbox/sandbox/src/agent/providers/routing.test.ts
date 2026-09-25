import { routingFor } from "./routing.js";

// The one rule for which account a conversation's turn runs on. Every daemon path that routes a turn (the decision's
// latch, the registry's profile write, a press, a queued batch) reads it, so its edges are pinned here by value.

const profile = { provider: "claude" as const, harness: "native" as const, account: "held" };

test("a turn naming no account continues on the conversation's own, and so its session", () => {
    expect(routingFor(profile, {})).toEqual({ provider: "claude", harness: "native", account: "held", continues: true });
});

test("a named account wins, and leaves the session its old account minted", () => {
    expect(routingFor(profile, { account: "other" })).toEqual({ provider: "claude", harness: "native", account: "other", continues: false });
    // Naming the account it already runs on changes nothing.
    expect(routingFor(profile, { account: "held" }).continues).toBe(true);
});

test("an account never crosses to a provider that did not mint it: another provider starts on auto", () => {
    expect(routingFor(profile, { agent: "codex" })).toEqual({ provider: "codex", harness: "native", account: undefined, continues: false });
});

test("a harness change keeps the provider's account, but not the session the other loop minted", () => {
    expect(routingFor(profile, { harness: "claude-code" })).toEqual({ provider: "claude", harness: "claude-code", account: "held", continues: false });
});

test("a conversation not opened yet runs on what it names, else auto", () => {
    expect(routingFor(undefined, {})).toEqual({ provider: "claude", harness: "native", account: undefined, continues: false });
    expect(routingFor(undefined, { account: "picked" }).account).toBe("picked");
});
