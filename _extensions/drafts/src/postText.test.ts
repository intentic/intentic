import { describe, expect, it } from "vitest";
import { countdownWords, destinationOf, isReply, limitOf, LONG_POST, postEdit, postsATitle } from "./postText";

// No mocks: postText is a leaf of pure functions over a draft's own fields, which is why the page can ask the
// same questions from four sections without four answers.

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

    /* TALKING TO THE ROOM VS TALKING TO ONE PERSON — the same URL with one more segment on it, and a different
     * decision for the reviewer. Both of reddit's permalink shapes say so, and a `?context=` on a thread does
     * not: that is still the thread's own address. */
    it("says when the target is one comment rather than the thread", () => {
        expect(destinationOf(`https://www.reddit.com/r/mcp/comments/1abc23/some_slug/kx9y8z7/`).verb).toBe(`reply to a comment in`);
        expect(destinationOf(`https://www.reddit.com/r/mcp/comments/1abc23/comment/kx9y8z7/`).verb).toBe(`reply to a comment in`);
        expect(destinationOf(`https://www.reddit.com/r/mcp/comments/1abc23/some_slug/kx9y8z7/`).label).toBe(`r/mcp`);
        expect(destinationOf(`https://www.reddit.com/r/mcp/comments/1abc23/some_slug/?context=3`).verb).toBe(`reply in`);
        expect(destinationOf(`https://www.reddit.com/r/mcp/comments/1abc23/some_slug`).verb).toBe(`reply in`);
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

describe("postEdit", () => {
    const reply = {
        platform: `reddit`,
        target: `https://www.reddit.com/r/mcp/comments/1abc23/slug/`,
        title: `Reply on r/mcp — why`,
        content: `as written`,
    };
    const article = { platform: `reddit`, target: `r/webdev`, title: `Ship it on Friday`, content: `as written` };

    it("carries the rewritten post", () => {
        expect(postEdit(reply, { content: `rewritten`, title: `` })).toEqual({ content: `rewritten` });
    });

    // The one that would be got wrong and never noticed: on a reply, `title` is the AGENT'S NOTE about the
    // draft. The editor draws no box for it, so sending the field back would post an empty headline over it.
    it("never touches a title the platform does not publish", () => {
        expect(postEdit(reply, { content: `rewritten`, title: `` })).not.toHaveProperty(`title`);
        // Even a title that somehow arrived changed is not a reason to save: the post itself is untouched.
        expect(postEdit(reply, { content: `as written`, title: `something else` })).toBeUndefined();
    });

    it("carries a published headline, trimmed", () => {
        expect(postEdit(article, { content: `as written`, title: `  Ship it on Monday  ` })).toEqual({
            content: `as written`,
            title: `Ship it on Monday`,
        });
    });

    // An identical re-post would still rewrite the file, refetch the queue and flash the row — a click that did
    // nothing, reported as if it did.
    it("is not a save when nothing changed", () => {
        expect(postEdit(article, { content: `as written`, title: `Ship it on Friday` })).toBeUndefined();
        expect(postEdit(reply, { content: `as written`, title: `` })).toBeUndefined();
    });
});

describe("countdownWords", () => {
    it("counts the hold down in the unit the decision is made in", () => {
        expect(countdownWords(43_000)).toBe(`43s`);
        // Rounded UP, so a countdown never shows a second the post still has: 0.4s left reads as 1s, not 0s.
        expect(countdownWords(400)).toBe(`1s`);
        expect(countdownWords(59_000)).toBe(`59s`);
    });

    it("never counts to zero", () => {
        // By the time a "0s" rendered next to a Stop button, the publisher already has the post — the button
        // would be promising something nobody can deliver.
        expect(countdownWords(0)).toBe(`any moment now`);
        expect(countdownWords(-5_000)).toBe(`any moment now`);
    });

    it("spells out the wider window the section covers", () => {
        // A post someone dated two minutes out is as imminent as a freshly approved one and shares the group.
        expect(countdownWords(90_000)).toBe(`1m 30s`);
        expect(countdownWords(61_000)).toBe(`1m 01s`);
    });
});

describe("LONG_POST", () => {
    // The fold threshold is a real screenful, not a stray small number: a tweet, a Discord note and an ordinary
    // reply have to stay whole, or every row in the queue grows a "show the whole post" toggle.
    it("leaves an ordinary post unfolded", () => {
        expect(LONG_POST).toBeGreaterThan(600);
    });
});
