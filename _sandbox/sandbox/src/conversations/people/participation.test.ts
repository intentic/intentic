import { conversationEntry } from "../registry/agents-store.testing.js";
import { joinedEntry, mentionedIn, notifiedEntry, personAsking } from "./participation.js";

// Who took part in a conversation, and each person's own answer to how much of it reaches them, as writes on its record:
// each answers undefined when nothing would change, so the registry writes and broadcasts only a real change.

const chat = conversationEntry({ id: "chat", identity: { startedBy: "bob@example.com" }, social: { owner: { email: "bob@example.com", since: 1 }, reactions: [] } });

test("a person joins once, lowercased, with how they came to it; whoever already took part is no change", () => {
    const joined = joinedEntry(chat, { email: "Ada@Example.com", name: "Ada" }, "answer", 5);
    expect(joined?.social.participants).toEqual([{ email: "ada@example.com", name: "Ada", since: 5, via: "answer" }]);
    expect(joined === undefined ? "missing" : joinedEntry(joined, { email: "ada@example.com" }, "prompt", 6)).toBeUndefined();
    // Its owner and its starter took part from the start.
    expect(joinedEntry(chat, { email: "bob@example.com" }, "prompt", 6)).toBeUndefined();
});

test("a person's answer is set, replaced and cleared, and the same answer twice is no change", () => {
    const asked = notifiedEntry(chat, "Ada@Example.com", "asks", 5);
    expect(asked?.social.notify).toEqual([{ email: "ada@example.com", level: "asks", at: 5 }]);
    expect(asked === undefined ? "missing" : notifiedEntry(asked, "ada@example.com", "asks", 6)).toBeUndefined();
    const muted = asked === undefined ? undefined : notifiedEntry(asked, "ada@example.com", "none", 7);
    expect(muted?.social.notify).toEqual([{ email: "ada@example.com", level: "none", at: 7 }]);
    const cleared = muted === undefined ? undefined : notifiedEntry(muted, "ada@example.com", null, 8);
    expect(cleared?.social).not.toHaveProperty("notify");
    expect(notifiedEntry(chat, "ada@example.com", null, 9)).toBeUndefined();
});

test("a message names members with @ and their address, and nobody the roster does not hold", () => {
    const roster = ["ada@example.com", "bob@example.com"];
    expect(mentionedIn("@Ada@Example.com can you look? cc @bob@example.com.", roster)).toEqual(["ada@example.com", "bob@example.com"]);
    // A bare address is not a mention, nor an address nobody here holds, nor the same person twice.
    expect(mentionedIn("mail ada@example.com or @eve@example.com, then @ada@example.com and @ada@example.com", roster)).toEqual(["ada@example.com"]);
});

test("the person asking for a turn is its starter when that is an address, never a program or a parent conversation", () => {
    expect(personAsking("ada@example.com", { email: "Ada@example.com", name: "Ada" })).toEqual({ email: "Ada@example.com", name: "Ada" });
    expect(personAsking("ada@example.com", undefined)).toEqual({ email: "ada@example.com" });
    expect(personAsking("token:deploy-bot", undefined)).toBeUndefined();
    expect(personAsking("agent:conv-1", undefined)).toBeUndefined();
    expect(personAsking(undefined, { email: "ada@example.com" })).toBeUndefined();
});
