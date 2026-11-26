import { extensionIdOf } from "@intentic/extension-manifest";
import { registerExtensionMessages } from "@intentic/extension-ui/i18n";
import { messages } from "./i18n";
import { manifest } from "./manifest";
import { countdownWords, destinationOf, isReply, limitOf, LONG_POST, postEdit, postsATitle } from "./postText";

await registerExtensionMessages(extensionIdOf(manifest), messages);

// No mocks: pure functions over a post's own fields, so the page can ask the same question from four sections.

describe("limitOf", () => {
    // The cards as a daemon with today's extensions serves them: each limit is the one its own card declares.
    const declared = new Map([
        [`x`, { name: `X`, messageLimit: 280 }],
        [`discord`, { name: `Discord`, messageLimit: 2_000 }],
        [`whatsapp`, { name: `WhatsApp`, messageLimit: 65_536 }],
        [`reddit`, { name: `Reddit` }],
    ]);

    it("answers what the platform's card declares and stays quiet for the rest", () => {
        expect(limitOf(`x`, declared)).toBe(280);
        expect(limitOf(`X`, declared)).toBe(280);
        expect(limitOf(`discord`, declared)).toBe(2_000);
        // Reddit's cap is far past anything written; an unknown platform has none either, so both get a plain count.
        expect(limitOf(`reddit`, declared)).toBeUndefined();
        expect(limitOf(`some-new-network`, declared)).toBeUndefined();
        expect(limitOf(`constructor`, declared)).toBeUndefined();
        // A platform no installed card names has no cap once any card declares one, whatever the old table said.
        expect(limitOf(`bluesky`, declared)).toBeUndefined();
    });

    it("counts a WhatsApp post against the linked-device ceiling the gateway sends at, not the Business API's", () => {
        // Was 4,096 here while the gateway sent up to 60,000: an inbox that refused what the gateway would have posted.
        expect(limitOf(`whatsapp`, declared)).toBe(65_536);
    });

    it("against a daemon whose cards declare no limits (before extension API 2.54.0), counts by the table it counted by", () => {
        const older = new Map([[`x`, { name: `X` }]]);
        expect(limitOf(`x`, older)).toBe(280);
        expect(limitOf(`bluesky`, older)).toBe(300);
        expect(limitOf(`some-new-network`, older)).toBeUndefined();
        expect(limitOf(`constructor`, new Map())).toBeUndefined();
    });
});

describe("postsATitle", () => {
    it("is a title on a platform that publishes one", () => {
        expect(postsATitle(`reddit`, `r/webdev`)).toBe(true);
        expect(postsATitle(`youtube`, undefined)).toBe(true);
    });

    // The two cases where `title` is the agent's note, not a headline: a platform with no titles, and any reply
    // (comments have no headline).
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

    // One more URL segment means replying to a comment, not the thread; both of reddit's permalink shapes count, but
    // `?context=` on a thread doesn't.
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

    // A target that starts with "http" and still isn't a URL: shown as written rather than swallowed.
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

    // On a reply, `title` is the agent's own note, not a headline the editor has a box for; saving it back would post
    // an empty headline.
    it("never touches a title the platform does not publish", () => {
        expect(postEdit(reply, { content: `rewritten`, title: `` })).not.toHaveProperty(`title`);
        // Even a changed title isn't a reason to save when the post itself is untouched.
        expect(postEdit(reply, { content: `as written`, title: `something else` })).toBeUndefined();
    });

    it("carries a published headline, trimmed", () => {
        expect(postEdit(article, { content: `as written`, title: `  Ship it on Monday  ` })).toEqual({
            content: `as written`,
            title: `Ship it on Monday`,
        });
    });

    // An identical re-post still rewrites the file and flashes the row: a no-op click reported as if it did something.
    it("is not a save when nothing changed", () => {
        expect(postEdit(article, { content: `as written`, title: `Ship it on Friday` })).toBeUndefined();
        expect(postEdit(reply, { content: `as written`, title: `` })).toBeUndefined();
    });
});

describe("countdownWords", () => {
    it("counts the hold down in the unit the decision is made in", () => {
        expect(countdownWords(43_000)).toBe(`43s`);
        // Rounds up, so the countdown never shows a second the post still has left.
        expect(countdownWords(400)).toBe(`1s`);
        expect(countdownWords(59_000)).toBe(`59s`);
    });

    it("never counts to zero", () => {
        // By the time "0s" renders next to Stop, the publisher already has the post; the button can't deliver on that
        // promise.
        expect(countdownWords(0)).toBe(`any moment now`);
        expect(countdownWords(-5_000)).toBe(`any moment now`);
    });

    it("spells out the wider window the section covers", () => {
        // A post someone dated two minutes out is as imminent as a freshly approved one and shares the group.
        expect(countdownWords(90_000)).toBe(`1m 30s`);
        // The kit's span of time, as every other one reads: no padded second, and none at all on the minute.
        expect(countdownWords(61_000)).toBe(`1m 1s`);
        expect(countdownWords(120_000)).toBe(`2m`);
    });
});

describe("LONG_POST", () => {
    // A real screenful, not an arbitrary number: an ordinary post must stay whole, or every row grows a show-more
    // toggle.
    it("leaves an ordinary post unfolded", () => {
        expect(LONG_POST).toBeGreaterThan(600);
    });
});
