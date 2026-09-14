// The dashboard's pure halves: which repositories are projects, what a tile says, and the name a new project gets.

// A tile: one repository under the workspace root. "root" is the workspace itself and is never a tile, since the
// dashboard is the list of things inside it.
export interface ProjectTile {
    // The repository id the daemon's routes take, which is also its folder under the workspace root.
    readonly id: string;
    readonly name: string;
    // The README's first paragraph, or empty while it has none.
    readonly summary: string;
    // Whether the Preview area can show it running (a dev server the daemon knows how to start).
    readonly hasPanel: boolean;
}

export const projectIds = (repos: readonly string[]): string[] => repos.filter((id) => id !== `root`).toSorted((left, right) => left.localeCompare(right));

// The first paragraph of a README that is not a heading, a badge line or a blank; empty when the file has none.
export const summaryOf = (readme: string): string => {
    const first = readme
        .replace(/\r\n/g, `\n`)
        .split(/\n\s*\n/)
        .map((block) => block.trim())
        .find((block) => block !== `` && !block.startsWith(`#`) && !block.startsWith(`[![`) && !block.startsWith(`<`) && !block.startsWith(`---`));
    return (first ?? ``).replace(/\s+/g, ` `);
};

// The name a press on New project gives before anyone types: the first free one in the series, so two presses in a
// row make two projects rather than one refusal.
export const freeProjectName = (existing: readonly string[], base = `new-project`): string => {
    const taken = new Set(existing);
    if (!taken.has(base)) {
        return base;
    }
    for (let n = 2; ; n++) {
        if (!taken.has(`${base}-${n}`)) {
            return `${base}-${n}`;
        }
    }
};

// What a typed name becomes as a folder: lowercase, words joined with hyphens, nothing git or a path would choke on.
// The daemon has the last word (isValidRepoName); this only keeps the common case from being refused.
export const slugOf = (typed: string): string =>
    typed
        .trim()
        .toLowerCase()
        .replace(/[^a-z0-9._-]+/g, `-`)
        .replace(/^[^a-z0-9]+/, ``)
        .replace(/-+$/, ``);

// Where a tile opens: the workspace rooted at the repository, the same address on the phone and the desktop.
export const projectPath = (id: string): string => `/workspace?dir=${encodeURIComponent(id)}`;

// Where See it opens: the Preview area on this repository's own target (previewModel.repoTargetId).
export const previewPath = (id: string): string => `/preview?target=${encodeURIComponent(`repo:${id}`)}`;
