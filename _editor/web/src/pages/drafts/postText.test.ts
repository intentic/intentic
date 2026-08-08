import { describe, expect, it } from "vitest";
import { destinationOf, isReply, limitOf, LONG_POST, paragraphsOf, postsATitle } from "./postText";

// No mocks: postText is a leaf of pure functions over a draft's own fields, which is why the page can ask the
// same questions from four sections without four answers.

describe("paragraphsOf", () => {
    it("breaks on blank lines and keeps single newlines inside their paragraph", () => {
        expect(paragraphsOf(`first\n\nsecond`)).toEqual([`first`, `second`]);
        // A chapter list, a Discord bullet list: deliberate line breaks inside ONE paragraph. Re-flowing them
        // would be this page rewriting the post.
        expect(paragraphsOf(`Chapters:\n00:00 one\n02:14 two`)).toEqual([`Chapters:\n00:00 one\n02:14 two`]);
    });

    it("survives the whitespace agents actually write", () => {
        // Trailing spaces on the blank line (a wrapped editor), and three newlines rather than two.
        expect(paragraphsOf(`first\n   \nsecond\n\n\nthird`)).toEqual([`first`, `second`, `third`]);
        expect(paragraphsOf(`one line`)).toEqual([`one line`]);
    });
});

describe("limitOf", () => {
    it("answers for platforms with a hard cap and stays quiet for the rest", () => {
        expect(limitOf(`x`)).toBe(280);
        expect(limitOf(`X`)).toBe(280);
        expect(limitOf(`discord`)).toBe(2_000);
        // Reddit's cap is far past anything an agent writes, and an unknown platform has no cap to state —
        // both get a plain character count instead of a made-up denominator.
        expect(limitOf(`reddit`)).toBeUndefined();
        expect(limitOf(`some-new-network`)).toBeUndefined();
    });
});

describe("postsATitle", () => {
    it("is a title on a platform that publishes one", () => {
        expect(postsATitle(`reddit`, `r/webdev`)).toBe(true);
        expect(postsATitle(`youtube`, undefined)).toBe(true);
    });

    /* THE TWO CASES WHERE `title` IS THE AGENT TALKING, not the post's headline: a platform with no titles at
     * all, and a reply — comments carry no headline anywhere, whatever the platform. Both used to render as a
     * three-line bold block above the post they had no business outweighing. */
    it("is a note on a platform without titles, and on any reply", () => {
        expect(postsATitle(`x`, undefined)).toBe(false);
        expect(postsATitle(`discord`, `#releases`)).toBe(false);
        expect(postsATitle(`reddit`, `https://www.reddit.com/r/ClaudeAI/comments/1vibxas/i_could_never_tell/`)).toBe(false);
    });
});

describe("destinationOf", () => {
    it("passes through a target that already reads as a place", () => {
        expect(destinationOf(`r/webdev`)).toEqual({ label: `r/webdev` });
        expect(destinationOf(`#releases`)).toEqual({ label: `#releases` });
        expect(destinationOf(`@ada@hachyderm.io`)).toEqual({ label: `@ada@hachyderm.io` });
    });

    it("reduces a reddit thread to the subreddit it is under", () => {
        const url = `https://www.reddit.com/r/ClaudeAI/comments/1vibxas/i_could_never_tell_which_of_my_claude_code/`;
        expect(destinationOf(url)).toEqual({ label: `r/ClaudeAI`, verb: `reply in`, href: url });
        // Old-reddit and the bare host reach the same place, so they read the same.
        expect(destinationOf(`https://old.reddit.com/r/webdev/comments/abc/title/`).label).toBe(`r/webdev`);
        expect(destinationOf(`https://reddit.com/r/webdev/comments/abc/title/`).label).toBe(`r/webdev`);
    });

    it("falls back to the host for a reply anywhere else", () => {
        expect(destinationOf(`https://x.com/intentic_dev/status/1234567890`)).toEqual({
            label: `x.com`,
            verb: `reply on`,
            href: `https://x.com/intentic_dev/status/1234567890`,
        });
        expect(destinationOf(`https://www.youtube.com/watch?v=abc`).label).toBe(`youtube.com`);
    });

    // A target that starts with "http" and still isn't a URL — shown as written rather than swallowed.
    it("shows an unparseable target as it was written", () => {
        expect(destinationOf(`https://`)).toEqual({ label: `https://` });
    });
});

describe("isReply", () => {
    it("is a reply exactly when the target is somewhere that already exists", () => {
        expect(isReply(`https://www.reddit.com/r/webdev/comments/abc/x/`)).toBe(true);
        expect(isReply(`r/webdev`)).toBe(false);
        expect(isReply(undefined)).toBe(false);
    });
});

describe("LONG_POST", () => {
    // The fold threshold is a real screenful, not a stray small number: a tweet, a Discord note and an ordinary
    // reply have to stay whole, or every row in the queue grows a "show the whole post" toggle.
    it("leaves an ordinary post unfolded", () => {
        expect(LONG_POST).toBeGreaterThan(600);
    });
});
