import { unstubbed } from "@intentic/testing";
import type { Services } from "../../../composition.js";
import { conversationEntry } from "../../../testing.js";
import { routingFor, sessionFor } from "./routing.js";

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
    const codex = { provider: "codex" as const, harness: "native" as const, account: "held" };
    expect(routingFor(codex, { agent: "codex", harness: "claude-code" })).toEqual({ provider: "codex", harness: "claude-code", account: "held", continues: false });
});

// Claude, Kimi, Cursor and the rest run one loop whatever the request names, so naming the other one is no change: a
// conversation recorded under "claude-code" before requests were normalized keeps its session.
test("a harness the provider does not offer is its own loop, named as such, and keeps the session", () => {
    expect(routingFor(profile, { harness: "claude-code" })).toEqual({ provider: "claude", harness: "native", account: "held", continues: true });
    const recordedAsClaudeCode = { provider: "cursor" as const, harness: "claude-code" as const, account: "held" };
    expect(routingFor(recordedAsClaudeCode, { agent: "cursor" })).toEqual({ provider: "cursor", harness: "native", account: "held", continues: true });
});

test("a conversation not opened yet runs on what it names, else auto", () => {
    expect(routingFor(undefined, {})).toEqual({ provider: "claude", harness: "native", account: undefined, continues: false });
    expect(routingFor(undefined, { account: "picked" }).account).toBe("picked");
});

// The one rule for which session a turn continues, over the same facts: the conversation's record and the session its
// actors hold for it. A sender's own idea of the session is no part of it.
const recorded = (minted: { provider: "claude" | "codex"; harness: "native" | "claude-code"; account?: string }, session: string | undefined) =>
    unstubbed<Pick<Services, "agents" | "conversations">>("services", {
        agents: unstubbed<Services["agents"]>("agents", { entry: (id: string) => (id === "c1" ? conversationEntry({ id, profile: minted }) : undefined) }),
        conversations: unstubbed<Services["conversations"]>("conversations", { sessionIdOf: (id: string) => (id === "c1" ? session : undefined) }),
    });

describe("the session a turn continues", () => {
    const held = recorded(profile, "sess-held");

    it("is the conversation's own, on the runtime and account that minted it, whatever session the sender named", () => {
        expect(sessionFor(held, { conversationId: "c1", sessionId: "sess-sent" })).toBe("sess-held");
        expect(sessionFor(held, { conversationId: "c1", agent: "claude", harness: "native", account: "held" })).toBe("sess-held");
    });

    it("is none on another provider, another loop or another account, however the sender named one", () => {
        expect(sessionFor(held, { conversationId: "c1", agent: "codex", sessionId: "sess-sent" })).toBeUndefined();
        const onCodex = recorded({ provider: "codex", harness: "native", account: "held" }, "sess-codex");
        expect(sessionFor(onCodex, { conversationId: "c1", agent: "codex", harness: "claude-code", sessionId: "sess-sent" })).toBeUndefined();
        expect(sessionFor(held, { conversationId: "c1", account: "other", sessionId: "sess-sent" })).toBeUndefined();
    });

    it("is kept when the sender names the other name of the same loop", () => {
        expect(sessionFor(held, { conversationId: "c1", harness: "claude-code" })).toBe("sess-held");
    });

    it("is none for a conversation whose actors hold no session yet, even if the sender named one", () => {
        expect(sessionFor(recorded(profile, undefined), { conversationId: "c1", sessionId: "sess-sent" })).toBeUndefined();
    });

    it("is the one a sender names only for a conversation not on record yet, such as a past session resumed from the history menu", () => {
        expect(sessionFor(held, { conversationId: "c2", sessionId: "sess-past" })).toBe("sess-past");
        expect(sessionFor(held, { conversationId: "c2" })).toBeUndefined();
    });
});
