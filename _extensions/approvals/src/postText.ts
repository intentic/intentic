/* WHAT A POST IS, read off a body that could have come from anywhere. `platform` is a bare string by contract
 *, a new connector needs no contract change, so this page meets posts it has never heard of, and everything
 * here degrades to "just show the words" rather than to a wrong answer.
 *
 * The rules live in one module because the page asks them from four sections and they have to agree: a post
 * whose `title` is drawn as a headline must not also be drawn as a note beside it. */

/* HOW MUCH ROOM THE PLATFORM GIVES. The one fact about a post that a reviewer cannot work out by reading it and
 * that fails the post outright when it is wrong, an over-length X post doesn't post badly, it doesn't post.
 * Only platforms with a hard, well-known cap are listed; anything absent shows a plain character count, which
 * is a fact rather than a guess. Body limits (a title has its own, and this page shows one number, not two). */
const LIMITS: Record<string, number> = {
    bluesky: 300,
    discord: 2_000,
    instagram: 2_200,
    linkedin: 3_000,
    mastodon: 500,
    slack: 4_000,
    telegram: 4_096,
    threads: 500,
    whatsapp: 4_096,
    x: 280,
    youtube: 5_000,
};

export const limitOf = (platform: string): number | undefined => LIMITS[platform.toLowerCase()];

/* WHOSE TITLE IS IT. `title` means two different things in the wild and they want opposite treatment: on a
 * platform that publishes titles it IS the post's headline and belongs at the top in headline weight, and
 * everywhere else the agent has used the field as its own note about the post ("Reply on r/ClaudeAI: …,
 * pure-value reply, no product mention"). Drawn as a headline, that note is a three-line bold block sitting
 * above the post and outweighing it, the exact inversion this page exists to avoid.
 *
 * A REPLY HAS NO TITLE, whatever the platform. A post aimed at a URL is attaching itself to something that
 * already exists (a thread, a video, a tweet), and comments carry no headline on any platform, so a `title`
 * there is always the agent talking to the owner. */
const TITLED = new Set([`blog`, `devto`, `ghost`, `hackernews`, `linkedin`, `medium`, `reddit`, `substack`, `wordpress`, `youtube`]);

export const isReply = (target?: string): boolean => target?.startsWith(`http`) === true;

export const postsATitle = (platform: string, target?: string): boolean => TITLED.has(platform.toLowerCase()) && !isReply(target);

/* WHAT AN EDIT IS ALLOWED TO CARRY. The owner gets two boxes at most, the post, and the headline where the
 * platform publishes one, while the row is saved by re-posting the whole file, so this decides which of the
 * post's fields a rewrite may touch. Both rules are the kind that get got wrong once and then never noticed:
 *
 * A `title` THAT ISN'T PUBLISHED IS THE AGENT'S NOTE (postsATitle above), the editor never draws a box for it,
 * and a naive "send back both fields" would post an empty headline over that note.
 *
 * NOTHING CHANGED IS NOT A SAVE. Re-posting an identical body still rewrites the file, refetches the queue and
 * flashes the row, a click that did nothing, reported as if it did. An untouched edit resolves to `undefined`
 * and the caller just closes the box. */
export interface PostEdit {
    readonly content: string;
    readonly title?: string;
}

export const postEdit = (
    post: { readonly platform: string; readonly target?: string; readonly title?: string; readonly content: string },
    next: { readonly content: string; readonly title: string },
): PostEdit | undefined => {
    /* A BLANK HEADLINE IS NEVER WRITTEN. The editor saves as it is typed, so there is no Save button left to
     * disable while a required field is empty, and the moment someone selects a headline to retype it, the
     * field is empty. Writing that would put a post on disk that cannot go out at all (reddit and YouTube both
     * refuse an untitled one), for the sake of a keystroke that was on its way somewhere. So an emptied
     * headline means "unchanged": the post keeps the title it had until a new one is actually typed. */
    const headlined = postsATitle(post.platform, post.target) && next.title.trim() !== ``;
    const title = next.title.trim();
    const changed = next.content !== post.content || (headlined && title !== (post.title ?? ``));
    if (!changed) {
        return undefined;
    }
    return headlined ? { content: next.content, title } : { content: next.content };
};

/* WHERE A POST IS GOING, in the words the platform uses for it. A target is free text by contract and arrives
 * in three shapes: a place you already recognise (`r/webdev`, `#releases`, `@ada@hachyderm.io`), a URL of the
 * thing being replied to, or something a connector made up. Only the URL needs help, a 90-character thread
 * address rendered in full is the noisiest thing on the row and says less than "reply in r/ClaudeAI" does.
 *
 * The URL survives as the link and as the tooltip, so nothing is lost: the label is what you read, the address
 * is what you follow.
 *
 * A COMMENT AND A THREAD ARE DIFFERENT DECISIONS, and on Reddit they are the same URL with one more segment on
 * the end. Replying under a post is talking to the room; replying to a comment is talking to one person about
 * what they just said, and whether the reply lands depends on which, so the queue says which, rather than
 * making the reviewer count slashes or open the link to find out. */
export interface Destination {
    /** What the reader sees: a place on the platform, or the host when that is all the URL tells us. */
    readonly label: string;
    /** Present when the target is a reply, "reply in", "reply on", and absent for a plain place. */
    readonly verb?: string;
    /** Set only for a target that is somewhere to GO, so the row can offer to open it. */
    readonly href?: string;
}

// The trailing capture is the comment id: a thread permalink ends after /comments/<id>/<slug>/, and one more
// segment past it means the target is a single comment (both reddit's `/…/<slug>/<id>/` and its newer
// `/…/comment/<id>/` land here). Any query string, reddit hands out `?context=3`, stops the match, which is
// the right answer: it is still the thread's address.
const REDDIT_THREAD = /^https?:\/\/(?:[\w-]+\.)?reddit\.com\/(r\/[\w-]+)(?:\/comments\/\w+\/[^/]*\/(\w+))?/i;

export const destinationOf = (target: string): Destination => {
    if (!isReply(target)) {
        return { label: target };
    }
    const reddit = REDDIT_THREAD.exec(target);
    const subreddit = reddit?.[1];
    if (subreddit !== undefined) {
        return { label: subreddit, verb: reddit?.[2] === undefined ? `reply in` : `reply to a comment in`, href: target };
    }
    try {
        // The host alone: a reply's path is an id and a slug, which is the part a reader gains nothing from.
        return { label: new URL(target).hostname.replace(/^www\./, ``), verb: `reply on`, href: target };
    } catch {
        // A target that starts with "http" and still isn't a URL, show it as written rather than swallow it.
        return { label: target };
    }
};

/* HOW LONG IS LEFT TO STOP IT. Approving does not send a post, it starts a minute, so for that minute the
 * queue has one urgent readout, and it is counted in the unit the decision is made in. Seconds, because that is
 * what the window is made of: "in a minute" is not something you act on, "34s" is.
 *
 * IT NEVER SAYS ZERO. The last tick before a post goes out reads as the post going out, not as a countdown
 * that reached the end and stopped, a "0s" sitting next to a Stop button is a promise nobody can keep, since
 * by the time it renders the executor already has it. Anything past due, or an item the daemon is already
 * carrying out, says the same thing.
 *
 * The minutes form exists for the wider window the section covers (a post someone dated for two minutes' time
 * is also about to go out, and belongs in the same group), not for the hold itself. */
export const countdownWords = (msLeft: number): string => {
    if (msLeft <= 0) {
        return `any moment now`;
    }
    const seconds = Math.ceil(msLeft / 1_000);
    return seconds < 60 ? `${seconds}s` : `${Math.floor(seconds / 60)}m ${String(seconds % 60).padStart(2, `0`)}s`;
};

/* WHEN A POST IS LONG ENOUGH TO FOLD. Above this the card is taller than the decision it is asking for, and a
 * queue of them can't be scanned, so the body clamps with a "show the whole post" toggle. A threshold on the
 * CHARACTER COUNT rather than on the rendered height: it is the same answer on a phone and on a desk, it is
 * decided before the first paint (no measure, no reflow), and it is the number the footer is already showing.
 * Roughly a screenful of body text at this measure; a tweet, a Discord note and an ordinary reply stay whole. */
export const LONG_POST = 900;
