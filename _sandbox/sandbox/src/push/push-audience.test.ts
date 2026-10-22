import { childActor } from "../auth/principal.js";
import type { PersistedAgent } from "../conversations/registry/agents-store.js";
import { conversationEntry } from "../conversations/registry/agents-store.testing.js";
import { askedOf, finishedAudience } from "./push-audience.js";

// A home's news is its owner's alone, and its subagents' endings are the home's to judge, not a person's.

const ADA = { email: "ada@example.com", since: 1 };
const entries = new Map<string, PersistedAgent>([
    ["home-1", conversationEntry({ id: "home-1", identity: { home: true, startedBy: "ada@example.com" }, social: { owner: ADA, reactions: [] } })],
    ["sub-a", conversationEntry({ id: "sub-a", identity: { startedBy: childActor("home-1") }, social: { owner: ADA, reactions: [] } })],
    // A review the home opened on sub-a's work hangs under sub-a and reports to the home.
    ["sub-r", conversationEntry({ id: "sub-r", identity: { startedBy: childActor("sub-a"), fresh: { of: "sub-a", kind: "review", at: 1, by: "home-1" } } })],
    ["chat", conversationEntry({ id: "chat", identity: { startedBy: "bob@example.com" }, social: { owner: { email: "bob@example.com", since: 1 }, reactions: [] } })],
]);
const entryOf = (id: string) => entries.get(id);

test("a home's own ending goes to its owner, its family's to nobody, anybody else's to everyone away", () => {
    expect(finishedAudience(entryOf, "home-1")).toEqual({ kind: "member", email: "ada@example.com" });
    expect(finishedAudience(entryOf, "sub-a")).toEqual({ kind: "nobody" });
    expect(finishedAudience(entryOf, "sub-r")).toEqual({ kind: "nobody" });
    expect(finishedAudience(entryOf, "chat")).toEqual({ kind: "everyone" });
});

test("a card or a need anywhere in a home's family goes to its owner alone", () => {
    expect(askedOf(entryOf, "home-1")).toBe("ada@example.com");
    expect(askedOf(entryOf, "sub-r")).toBe("ada@example.com");
    expect(askedOf(entryOf, "chat")).toBeUndefined();
});
