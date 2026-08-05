/* WHICH REPOSITORY THE AREA OPENS ON when the URL names none.
 *
 * The rail's tile links to `/ext/documentation` with no query — that is what keeps the link stable — so the view
 * arrives holding nothing but the workspace's repo list. Opening on whichever repo the daemon listed first meant
 * every trip out of the area and back threw away the repository the reader had chosen, and discovery order has
 * nothing to do with where the reading is.
 *
 * Remembered per browser rather than daemon-side: this is where you left off reading, not a setting anyone would
 * want to find in a form — the same call the workflow designer's inspector width makes. */

const STORAGE_KEY = `ext-documentation-repo`;

export const rememberedRepo = (): string | undefined => {
    try {
        return localStorage.getItem(STORAGE_KEY) ?? undefined;
    } catch {
        // Storage may be unavailable (private mode); the preference below stands.
        return undefined;
    }
};

export const rememberRepo = (repo: string): void => {
    try {
        localStorage.setItem(STORAGE_KEY, repo);
    } catch {
        // Storage may be unavailable (private mode); the choice still holds for this visit.
    }
};

/* A remembered choice wins, but only while the workspace still has that repository — a clone that has gone away
 * must not strand the area on a page about nothing.
 *
 * With nothing remembered, PREFER A REPOSITORY THAT HAS DOCUMENTS. Most repos in a workspace have none, so the
 * first one alphabetically is usually an empty state offering to generate — while the set the reader came for
 * sits one dropdown away, unmentioned. `documented` is the presence map the Workspace tree's row icons already
 * run on, passed in so this stays pure. */
export const openingRepo = (repos: readonly string[], remembered: string | undefined, documented: (repo: string) => boolean): string => {
    if (remembered !== undefined && repos.includes(remembered)) {
        return remembered;
    }
    // "" is the workspace root repo, which is also the honest answer for a workspace with no repos at all.
    return repos.find((repo) => documented(repo)) ?? repos[0] ?? ``;
};
