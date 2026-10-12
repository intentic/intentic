import { conversationEntry } from "../../testing.js";
import { messageTaint } from "./fleet-message.js";

// What a message makes of the turn it lands in. A stranger's words taint it; the target's own family's words taint it
// only when they carry outside content from the sender's own turn, or come from a runtime nothing gates.

// A small workspace: one family (a root a person opened, its child, that child's child, and a sibling), and a second
// conversation of its own nobody spawned.
const entries = new Map(
    [
        conversationEntry({ id: "root", identity: { startedBy: "owner@example.com" } }),
        conversationEntry({ id: "child", identity: { startedBy: "agent:root" } }),
        conversationEntry({ id: "grandchild", identity: { startedBy: "agent:child" } }),
        conversationEntry({ id: "sibling", identity: { startedBy: "agent:root" } }),
        conversationEntry({ id: "blind", identity: { startedBy: "agent:root" }, profile: { provider: "pi", harness: "native" } }),
        conversationEntry({ id: "stranger", identity: { startedBy: "owner@example.com" } }),
    ].map((entry) => [entry.id, entry]),
);

// Each conversation's live taint, by id: none unless a test names one.
const taintOf = (tainted: ReadonlyMap<string, string> = new Map()) => ({
    entry: (id: string) => entries.get(id),
    taintOf: (id: string) => tainted.get(id),
});

test("its own family's clean words taint nothing, whichever way up the tree they travel", () => {
    expect(messageTaint(taintOf(), "child", "root")).toBeUndefined();
    expect(messageTaint(taintOf(), "grandchild", "root")).toBeUndefined();
    expect(messageTaint(taintOf(), "root", "child")).toBeUndefined();
    expect(messageTaint(taintOf(), "sibling", "child")).toBeUndefined();
});

test("a conversation outside the family is a stranger, however clean its own turn", () => {
    expect(messageTaint(taintOf(), "stranger", "root")).toBe("agent:stranger");
    expect(messageTaint(taintOf(), "child", "stranger")).toBe("agent:child");
});

test("a shell with no conversation stamp, or a sender the registry does not know, is a stranger", () => {
    expect(messageTaint(taintOf(), undefined, "root")).toBe("a message from an agent shell outside any conversation");
    expect(messageTaint(taintOf(), "gone", "root")).toBe("agent:gone");
});

test("a family member whose own turn read outside content passes it on, saying who relayed it", () => {
    expect(messageTaint(taintOf(new Map([["child", "a fetched page"]])), "child", "root")).toBe("a fetched page, relayed by `child`");
    expect(messageTaint(taintOf(new Map([["child", "agent:stranger"]])), "child", "root")).toBe(
        "a message from another conversation, `stranger`, relayed by `child`",
    );
});

test("a family member on a runtime with no permission rules of its own is never clean", () => {
    expect(messageTaint(taintOf(), "blind", "root")).toBe("a message from `blind`, which runs on pi, a runtime with no permission rules of its own");
});
