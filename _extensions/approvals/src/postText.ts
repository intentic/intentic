// What a post is, read off a body that could come from anywhere: `platform` is a bare string by contract, so an
// unrecognised one just shows the words instead of a wrong answer. Rules live in one module since four sections must
// agree on the same post.

import { messageLimitOf } from "@intentic/sandbox-contract/message-limits";
import { t } from "./i18n";

// Over the limit, a post doesn't post at all; absent means no known cap, so it just shows a plain count. The limits are
// the contract's one table, the same numbers the gateways spill a reply at and the daemon refuses a direct post past.
export const limitOf = (platform: string): number | undefined => messageLimitOf(platform);

// On a titled platform, `title` is the headline; elsewhere, or on any reply, it's the agent's own note.
const TITLED = new Set([`blog`, `devto`, `ghost`, `hackernews`, `linkedin`, `medium`, `reddit`, `substack`, `wordpress`, `youtube`]);

export const isReply = (target?: string): boolean => target?.startsWith(`http`) === true;

export const postsATitle = (platform: string, target?: string): boolean => TITLED.has(platform.toLowerCase()) && !isReply(target);

// What an edit may change: the post, and the headline where published, since a rewrite re-posts the whole file. An
// unpublished `title` is the agent's note, never overwritten; no change resolves to `undefined`, not a write.
export interface PostEdit {
    readonly content: string;
    readonly title?: string;
}

export const postEdit = (
    post: { readonly platform: string; readonly target?: string; readonly title?: string; readonly content: string },
    next: { readonly content: string; readonly title: string },
): PostEdit | undefined => {
    // An emptied headline means unchanged, not blank: saving as typed leaves no field to disable while retyping, and
    // reddit/YouTube both refuse an untitled post.
    const headlined = postsATitle(post.platform, post.target) && next.title.trim() !== ``;
    const title = next.title.trim();
    const changed = next.content !== post.content || (headlined && title !== (post.title ?? ``));
    if (!changed) {
        return undefined;
    }
    return headlined ? { content: next.content, title } : { content: next.content };
};

// Label destination text according to the URL or free-text target.
export interface Destination {
    /** What the reader sees: a place on the platform, or the host when that is all the URL tells us. */
    readonly label: string;
    /** Present when the target is a reply, "reply in", "reply on", and absent for a plain place. */
    readonly verb?: string;
    /** Set only for a target that is somewhere to GO, so the row can offer to open it. */
    readonly href?: string;
}

// One more segment past /comments/<id>/<slug>/ means a single comment; a query string doesn't count.
const REDDIT_THREAD = /^https?:\/\/(?:[\w-]+\.)?reddit\.com\/(r\/[\w-]+)(?:\/comments\/\w+\/[^/]*\/(\w+))?/i;

export const destinationOf = (target: string): Destination => {
    if (!isReply(target)) {
        return { label: target };
    }
    const reddit = REDDIT_THREAD.exec(target);
    const subreddit = reddit?.[1];
    if (subreddit !== undefined) {
        return { label: subreddit, verb: reddit?.[2] === undefined ? t(`postText.replyIn`) : t(`postText.replyToCommentIn`), href: target };
    }
    try {
        // The host alone: a reply's path is an id and a slug, which is the part a reader gains nothing from.
        return { label: new URL(target).hostname.replace(/^www\./, ``), verb: t(`postText.replyOn`), href: target };
    } catch {
        // Starts with "http" but still isn't a URL: shown as written rather than swallowed.
        return { label: target };
    }
};

// Time left in the unit the decision is made in: approving starts a hold, not a send. Never zero: the last tick reads
// as "any moment now", since by then the executor already has the post.
export const countdownWords = (msLeft: number): string => {
    if (msLeft <= 0) {
        return t(`postText.anyMomentNow`);
    }
    const seconds = Math.ceil(msLeft / 1_000);
    return seconds < 60
        ? t(`postText.seconds`, { seconds })
        : t(`postText.minutesSeconds`, { minutes: Math.floor(seconds / 60), seconds: String(seconds % 60).padStart(2, `0`) });
};

// Character-count fold threshold, decided before paint: a screenful of body text; an ordinary post stays whole.
export const LONG_POST = 900;
