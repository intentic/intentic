/* Clone names are derived from the repository URL. */

// The last path segment, minus `.git`, `https://host/owner/repo.git`, `git@host:owner/repo` and a trailing
// slash all yield `repo`. Empty when there is no segment to take, which callers read as "not a repository yet".
export const repoNameFromUrl = (url: string): string => {
    // `:` splits the scp-style form (git@host:owner/repo), whose separator is not a slash.
    const last = url.trim().replace(/\/+$/, ``).split(/[/:]/).pop() ?? ``;
    return last.replace(/\.git$/i, ``);
};
