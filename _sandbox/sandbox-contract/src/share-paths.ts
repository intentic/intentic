/* WHERE A SHARED CONVERSATION LIVES INSIDE THE OUTBOX — one layout, stated once, because three separate
 * things have to agree on it and only one of them is code that runs at the same time as the others.
 *
 *   public/
 *     conversations/
 *       _viewer/            the page's built assets, copied in once and shared by every share
 *       <id>/
 *         index.html        the page, with its conversation baked in
 *         files/            the pictures that conversation showed, copied out of the workspace
 *
 * The VIEWER's build has to know its own address before it is ever published (its asset URLs are absolute —
 * `/conversations/_viewer/assets/…` — so that one copy of the assets serves every share and a recipient's
 * browser caches them across links). The DAEMON has to write the tree. And the outbox's own rules have to
 * leave all of it alone: nothing here begins with a dot, which is the one shape that is never served.
 *
 * A directory per share rather than a bare `<id>.html`, so a share owns its pictures — "stop sharing" is then
 * one directory removed, and cannot half-succeed by leaving a folder of someone's screenshots behind. */

// Top-level folder inside `public/`. Reads as what it is in the address bar, which matters: this is a string
// people paste to each other.
export const SHARE_DIR = "conversations";

// The one copy of the page's assets. Underscored to sort away from the shares themselves and to read as
// machinery rather than as somebody's conversation.
export const SHARE_VIEWER_DIR = "_viewer";

// Where a share's pictures sit, relative to its own page — and therefore also the prefix every rewritten
// image path in the payload carries.
export const SHARE_FILES_DIR = "files";

// The absolute path the built assets are served from, and the `base` the page is built with.
export const SHARE_VIEWER_BASE = `/${SHARE_DIR}/${SHARE_VIEWER_DIR}/`;

/* The id a share is filed under: a readable stem from the title, plus randomness that is the ONLY thing
 * standing between a stranger and the conversation.
 *
 * Both halves earn their place. The stem is what makes a pasted link say what it points at ("…/conversations/
 * login-redirect-fix-3f9c…"), which is most of why anyone trusts clicking one. The tail is the security: the
 * outbox answers on an unguessable hostname AND requires the exact path (public-files.ts rule 4 — there is no
 * listing), so an address is protected by the sum of the two, and the half this module controls must not be
 * derivable from a title anyone could guess. */
const STEM_MAX = 48;

export const shareStem = (title: string): string => {
    const stem = title
        .toLowerCase()
        .normalize("NFKD")
        // Anything that is not a plain letter or digit becomes a separator, which retires accents, punctuation,
        // emoji and every writing system that would otherwise arrive percent-encoded in the address bar.
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, STEM_MAX)
        .replace(/-+$/, "");
    // A title made entirely of characters the rule above drops (a CJK title, an emoji) leaves nothing to read;
    // the id is then the random half alone, which is still a perfectly good id.
    return stem;
};

// `<stem>-<random>`, or the random half alone when the title had no letters to give.
export const shareId = (title: string, random: string): string => {
    const stem = shareStem(title);
    return stem === "" ? random : `${stem}-${random}`;
};

// What a share's own id must look like before it is ever joined onto a path — the same shape the daemon's
// other id guards take (transcript-record.ts FILE_ID), and the reason a share id from the wire can be trusted
// into a directory name.
export const SHARE_ID = /^[a-z0-9][a-z0-9-]{0,95}$/;
