import { AGENT_GIT_AUTHOR, attributionOf, UNATTRIBUTED, withConversationTrailer, withTrailers } from "./git-identity.js";

test("a bare subject gets the trailer as a paragraph of its own, even one shaped like a trailer", () => {
    expect(withConversationTrailer("Agent: fix the parser", "c1")).toBe("Agent: fix the parser\n\nConversation-Id: c1");
});

// git reads only the last paragraph as trailers: a second one would hide Test-Note and Allow from the push check.
test("a message ending in trailers gets the conversation in the same paragraph", () => {
    expect(withConversationTrailer("fix: rows\n\nTest-Note: rows became a table\nAllow: tidy — moved", "c1")).toBe(
        "fix: rows\n\nTest-Note: rows became a table\nAllow: tidy — moved\nConversation-Id: c1",
    );
});

test("a body of prose is not a trailer paragraph", () => {
    expect(withConversationTrailer("fix: rows\n\nThe table was rebuilt.", "c1")).toBe("fix: rows\n\nThe table was rebuilt.\n\nConversation-Id: c1");
});

test("trailers already in the message are not added twice, and new ones share one paragraph", () => {
    expect(withTrailers("fix: rows\n\nConversation-Id: c1", ["Conversation-Id: c1", "Co-authored-by: Ada <ada@example.com>"])).toBe(
        "fix: rows\n\nConversation-Id: c1\nCo-authored-by: Ada <ada@example.com>",
    );
    expect(withTrailers("fix: rows", [])).toBe("fix: rows");
});

describe("how the owner's policy names a person", () => {
    const ada = { name: "Ada", email: "ada@example.com" };

    test("`person` makes them the author and keeps the agent the committer", () => {
        expect(attributionOf("person", ada)).toEqual({ signer: { ...AGENT_GIT_AUTHOR, author: ada }, trailers: [] });
    });

    test("`trailer` keeps the agent the author and adds a Co-authored-by line", () => {
        expect(attributionOf("trailer", ada)).toEqual({ signer: AGENT_GIT_AUTHOR, trailers: ["Co-authored-by: Ada <ada@example.com>"] });
    });

    test("`intentic`, or a person with no identity of their own, names nobody", () => {
        expect(attributionOf("intentic", ada)).toBe(UNATTRIBUTED);
        expect(attributionOf("person", undefined)).toBe(UNATTRIBUTED);
    });
});
