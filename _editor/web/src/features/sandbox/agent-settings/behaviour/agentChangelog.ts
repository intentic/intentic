// How the changelog setting lays out a workspace's repositories: one lane of chips per parent folder, so the
// folder ("extensions/") is said once over its repos instead of on every one. A folder holding a single repo
// joins the top lane under its full path, since a lane of one chip would say the folder for nothing.

export type ChangelogLane = {
    /** The shared folder, with its trailing slash; undefined for the top lane. */
    readonly folder: string | undefined;
    readonly chips: readonly { readonly repo: string; readonly name: string }[];
};

const parentOf = (repo: string): string | undefined => {
    const cut = repo.lastIndexOf(`/`);
    return cut === -1 ? undefined : repo.slice(0, cut + 1);
};

// Keeps the order `repos` arrives in (useRepos puts `root` first), both across lanes and within each.
export const changelogLanes = (repos: readonly string[], rootLabel: string): ChangelogLane[] => {
    const byFolder = new Map<string, string[]>();
    for (const repo of repos) {
        const folder = parentOf(repo);
        if (folder !== undefined) {byFolder.set(folder, [...(byFolder.get(folder) ?? []), repo]);}
    }
    const top = repos
        .filter((repo) => {
            const folder = parentOf(repo);
            return folder === undefined || byFolder.get(folder)?.length === 1;
        })
        .map((repo) => ({ repo, name: repo === `root` ? rootLabel : repo }));
    const lanes: ChangelogLane[] = top.length > 0 ? [{ folder: undefined, chips: top }] : [];
    for (const [folder, members] of byFolder) {
        if (members.length > 1) {lanes.push({ folder, chips: members.map((repo) => ({ repo, name: repo.slice(folder.length) })) });}
    }
    return lanes;
};
