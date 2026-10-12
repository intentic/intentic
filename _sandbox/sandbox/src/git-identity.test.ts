import { withConversationTrailer } from "./git-identity.js";

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
