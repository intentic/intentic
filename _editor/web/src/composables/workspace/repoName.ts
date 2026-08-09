/* THE NAME A CLONE LANDS UNDER, derived from its URL rather than asked for — one field is the whole difference
 * between "paste your repository address" and a form. The daemon reserves a handful of names (role scaffolding,
 * "root", the reference shelf, the outbox) and refuses anything outside a safe segment; that check stays THERE,
 * so this only has to answer what the address is called. Split from useAddRepo so it is testable as the pure
 * string function it is. */

// The last path segment, minus `.git` — `https://host/owner/repo.git`, `git@host:owner/repo` and a trailing
// slash all yield `repo`. Empty when there is no segment to take, which callers read as "not a repository yet".
export const repoNameFromUrl = (url: string): string => {
    // `:` splits the scp-style form (git@host:owner/repo), whose separator is not a slash.
    const last = url.trim().replace(/\/+$/, ``).split(/[/:]/).pop() ?? ``;
    return last.replace(/\.git$/i, ``);
};
