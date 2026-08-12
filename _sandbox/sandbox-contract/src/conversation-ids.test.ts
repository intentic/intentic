import { expect, test } from "vitest";
import { newConversationId } from "./conversation-ids.js";
import { ConversationIdSchema } from "./schemas.js";

// The one property that is not a matter of taste: this string becomes a git branch and a filesystem path, and
// the id guard is what stands between those and an injection. Held over a large sample rather than one draw,
// because the generator picks from three independent spaces and any of them could produce the bad character.
test("every generated id passes the conversation-id guard", () => {
    for (let index = 0; index < 2_000; index += 1) {
        expect(ConversationIdSchema.safeParse(newConversationId()).success).toBe(true);
    }
});

test("an id reads as a word pair with a short tail, and stays short", () => {
    const id = newConversationId();
    expect(id).toMatch(/^[a-z]+-[a-z]+-[0-9a-z]{4}$/);
    // Comfortably under a UUID's 36, which is the whole reason this exists.
    expect(id.length).toBeLessThan(24);
});

// The tail is what makes the readable half safe to repeat: names may rhyme, ids may not.
test("ids are unique across a burst", () => {
    const ids = new Set(Array.from({ length: 5_000 }, newConversationId));
    expect(ids.size).toBe(5_000);
});
