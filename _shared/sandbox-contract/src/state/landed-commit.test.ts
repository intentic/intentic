import { expect, test } from "bun:test";
import { declaredTestNote, landedCommitMessage } from "./landed-commit.js";

// The push gate reads a weakening's declaration off the commit (assertion-ratchet.mjs), so the trailer must survive
// the trip from the conversation's last word into the message a land commits under.

test("a landed message commits as its subject and one trailer paragraph, the test note included", () => {
    expect(landedCommitMessage({ subject: "fix: tabs" })).toBe("fix: tabs");
    expect(landedCommitMessage({ subject: "feat: tabs", note: "Tabs remember.", breaking: "Old API gone.", testNote: "Rows became a table." })).toBe(
        "feat: tabs\n\nRelease-Note: Tabs remember.\nBreaking-Note: Old API gone.\nTest-Note: Rows became a table.",
    );
});

test("a Test-Note is read only from a line that starts with one and says something", () => {
    expect(declaredTestNote("Done.\n\nTest-Note: the prose assertion became a structural one\n")).toBe("the prose assertion became a structural one");
    expect(declaredTestNote("I kept a Test-Note: nowhere near the start")).toBeUndefined();
    expect(declaredTestNote("Test-Note:   \n")).toBeUndefined();
});
