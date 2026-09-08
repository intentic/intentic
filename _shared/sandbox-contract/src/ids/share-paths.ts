// Where a shared conversation lives inside the outbox; the viewer's build, the daemon and the outbox's dot-file rule
// all agree on it.
// public/conversations/_viewer/ - the page's built assets, shared by every share
// public/conversations/<id>/ - index.html plus a files/ directory for its pictures
// A directory per share, not a bare file, so removing one removes all of it, pictures included.

// Top-level folder inside `public/`; reads as itself in the address bar, a string people paste to each other.
export const SHARE_DIR = "conversations";

// The one copy of the page's assets; underscored to sort away from shares, reading as machinery.
export const SHARE_VIEWER_DIR = "_viewer";

// Where a share's pictures sit relative to its own page; also the prefix every rewritten image path carries.
export const SHARE_FILES_DIR = "files";

// The absolute path the built assets are served from, and the `base` the page is built with.
export const SHARE_VIEWER_BASE = `/${SHARE_DIR}/${SHARE_VIEWER_DIR}/`;

// The id a share is filed under: a readable stem from the title, plus a random tail that is the only thing standing
// between a stranger and the conversation. The stem must never be relied on for that: it's guessable by construction.
const STEM_MAX = 48;

export const shareStem = (title: string): string => {
    const stem = title
        .toLowerCase()
        .normalize("NFKD")
        // Anything not a plain letter or digit becomes a separator, dropping accents, punctuation, emoji.
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/^-+|-+$/g, "")
        .slice(0, STEM_MAX)
        .replace(/-+$/, "");
    // A title with nothing left after stripping (CJK, emoji) leaves an empty stem; the id is the random half alone.
    return stem;
};

// `<stem>-<random>`, or the random half alone when the title had no letters to give.
export const shareId = (title: string, random: string): string => {
    const stem = shareStem(title);
    return stem === "" ? random : `${stem}-${random}`;
};

// The shape a share id must have before joining it onto a path, same as transcript-record.ts's FILE_ID.
export const SHARE_ID = /^[a-z0-9][a-z0-9-]{0,95}$/;
