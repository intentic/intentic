// Which repository the area opens on when the URL names none; remembered per browser, not daemon-side, since this is
// where you left off reading, not a setting.

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

// A remembered choice wins only while the workspace still has it. Otherwise prefers a repo with documents, since most
// have none and alphabetical-first is usually an empty state.
export const openingRepo = (repos: readonly string[], remembered: string | undefined, documented: (repo: string) => boolean): string => {
    if (remembered !== undefined && repos.includes(remembered)) {
        return remembered;
    }
    // "" is the workspace root repo, which is also the honest answer for a workspace with no repos at all.
    return repos.find((repo) => documented(repo)) ?? repos[0] ?? ``;
};
