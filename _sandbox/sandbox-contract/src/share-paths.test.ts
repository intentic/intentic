import { describe, expect, it } from "vitest";
import { SHARE_ID, shareId, shareStem } from "./share-paths.js";

/* The id a shared conversation is filed under is two things at once: the readable half of a link somebody
 * pastes, and the half of the address that has to be safe to join onto a directory path. Both halves are
 * checked here, because the id is minted from a TITLE the user typed. */

describe("the readable half", () => {
    it("makes a link that says what it points at", () => {
        expect(shareId("Fix the login redirect loop", "3f9c")).toBe("fix-the-login-redirect-loop-3f9c");
    });

    it("keeps a long title from running away with the address", () => {
        const id = shareId("a".repeat(200), "3f9c");
        expect(id.length).toBeLessThanOrEqual(64);
        expect(SHARE_ID.test(id)).toBe(true);
    });

    // A title in a writing system this alphabet cannot carry leaves the random half standing alone, which is
    // still a perfectly good id — and a better outcome than an address full of percent-encoding.
    it("falls back to the random half when a title has no letters to give", () => {
        expect(shareStem("日本語のタイトル")).toBe("");
        expect(shareId("日本語のタイトル", "3f9c")).toBe("3f9c");
    });
});

describe("the safe half", () => {
    /* The id is joined onto a path, so a title is the one attacker-shaped input in it. These are the shapes
     * that would matter if the alphabet were not closed. */
    it.each([
        ["../../etc/passwd", "etc-passwd"],
        ["a/b", "a-b"],
        [".hidden", "hidden"],
        ["  spaces  everywhere  ", "spaces-everywhere"],
        ["Emoji 🎉 title", "emoji-title"],
        ["UPPER Case", "upper-case"],
    ])("reduces %j to a name that can only be a name", (title, stem) => {
        expect(shareStem(title)).toBe(stem);
        expect(SHARE_ID.test(shareId(title, "3f9c"))).toBe(true);
    });

    // The guard the daemon applies before joining an id onto a directory, held to the whole minted space: no
    // title can produce something it rejects, which is what makes a rejection there a bug rather than input.
    it("mints nothing its own guard would refuse", () => {
        const titles = ["Fix login", "../..", "🎉", "a".repeat(300), "-leading-dash", "trailing-dash-"];
        expect(titles.every((title) => SHARE_ID.test(shareId(title, "00112233445566ff")))).toBe(true);
    });
});
