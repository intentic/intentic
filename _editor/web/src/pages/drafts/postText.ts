/* WHAT A DRAFT IS, read off a body that could have come from anywhere. `platform` is a bare string by contract
 * — a new connector needs no contract change — so this page meets posts it has never heard of, and everything
 * here degrades to "just show the words" rather than to a wrong answer.
 *
 * The rules live in one module because the page asks them from four sections and they have to agree: a draft
 * whose `title` is drawn as a post title must not also be drawn as a note beside it. */

/* THE POST AS PARAGRAPHS. A draft's content is the exact string that will be submitted, and every platform
 * agrees on one thing: a blank line starts a new paragraph. Splitting on that lets the paragraphs be spaced
 * like paragraphs instead of being separated by an empty line of body text — which is what a single
 * `whitespace-pre-wrap` block does, and why the long drafts read as one grey slab.
 *
 * Single newlines stay INSIDE their paragraph (the block keeps `whitespace-pre-wrap`): a YouTube description's
 * chapter list and a Discord release note's bullets are one paragraph of deliberate line breaks, and re-flowing
 * them would be this page rewriting the post. Nothing is added, removed or re-ordered here — the reviewer is
 * approving these bytes.
 *
 * The whole run of blank lines is ONE break — a draft written with three of them is one paragraph gap, not a
 * gap plus an empty line at the top of the next paragraph — and `\r\n` counts, since a draft file is written
 * by whatever the agent had to hand. */
export const paragraphsOf = (content: string): string[] => content.split(/(?:\r?\n[ \t]*){2,}/).filter((paragraph) => paragraph.trim() !== ``);

/* HOW MUCH ROOM THE PLATFORM GIVES. The one fact about a post that a reviewer cannot work out by reading it and
 * that fails the post outright when it is wrong — an over-length X draft doesn't post badly, it doesn't post.
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
 * everywhere else the agent has used the field as its own note about the draft ("Reply on r/ClaudeAI: … —
 * pure-value reply, no product mention"). Drawn as a headline, that note is a three-line bold block sitting
 * above the post and outweighing it — the exact inversion this page exists to avoid.
 *
 * A REPLY HAS NO TITLE, whatever the platform. A draft aimed at a URL is attaching itself to something that
 * already exists (a thread, a video, a tweet), and comments carry no headline on any platform — so a `title`
 * there is always the agent talking to the owner. */
const TITLED = new Set([`blog`, `devto`, `ghost`, `hackernews`, `linkedin`, `medium`, `reddit`, `substack`, `wordpress`, `youtube`]);

export const isReply = (target?: string): boolean => target?.startsWith(`http`) === true;

export const postsATitle = (platform: string, target?: string): boolean => TITLED.has(platform.toLowerCase()) && !isReply(target);

/* WHERE A DRAFT IS GOING, in the words the platform uses for it. A target is free text by contract and arrives
 * in three shapes: a place you already recognise (`r/webdev`, `#releases`, `@ada@hachyderm.io`), a URL of the
 * thing being replied to, or something a connector made up. Only the URL needs help — a 90-character thread
 * address rendered in full is the noisiest thing on the row and says less than "reply in r/ClaudeAI" does.
 *
 * The URL survives as the link and as the tooltip, so nothing is lost: the label is what you read, the address
 * is what you follow. */
export interface Destination {
    /** What the reader sees: a place on the platform, or the host when that is all the URL tells us. */
    readonly label: string;
    /** Present when the target is a reply — "reply in", "reply on" — and absent for a plain place. */
    readonly verb?: string;
    /** Set only for a target that is somewhere to GO, so the row can offer to open it. */
    readonly href?: string;
}

const REDDIT_THREAD = /^https?:\/\/(?:[\w-]+\.)?reddit\.com\/(r\/[\w-]+)/i;

export const destinationOf = (target: string): Destination => {
    if (!isReply(target)) {
        return { label: target };
    }
    const subreddit = REDDIT_THREAD.exec(target)?.[1];
    if (subreddit !== undefined) {
        return { label: subreddit, verb: `reply in`, href: target };
    }
    try {
        // The host alone: a reply's path is an id and a slug, which is the part a reader gains nothing from.
        return { label: new URL(target).hostname.replace(/^www\./, ``), verb: `reply on`, href: target };
    } catch {
        // A target that starts with "http" and still isn't a URL — show it as written rather than swallow it.
        return { label: target };
    }
};

/* WHEN A POST IS LONG ENOUGH TO FOLD. Above this the card is taller than the decision it is asking for, and a
 * queue of them can't be scanned — so the body clamps with a "show the whole post" toggle. A threshold on the
 * CHARACTER COUNT rather than on the rendered height: it is the same answer on a phone and on a desk, it is
 * decided before the first paint (no measure, no reflow), and it is the number the footer is already showing.
 * Roughly a screenful of body text at this measure; a tweet, a Discord note and an ordinary reply stay whole. */
export const LONG_POST = 900;
