import { gitView, viewKey } from "./gitView";
import type { GitOperation } from "@intentic/sandbox-contract/schemas/git/git";
import { refuse } from "@intentic/contract-serve";
import { deskSeed } from "../../fixture/git/deskHistory";
import { applyBody, type Binary, type RepoSeed, type SeedAuthor, shopSeed } from "../../fixture/git/gitSeeds";
import { REPOS } from "../../fixture/workspace";
import { deskEdition, freshEdition } from "../../mode";
import { seedSha, shaOf } from "./gitSha";
import { listeners, OWNER, STARTED_AT, TEAMMATE } from "../board/roster";

// Each repo's commit graph for one page load: the commits, the refs on them, the reflog undo walks, the stash, and what
// the simulated remote holds. Built from fixture/git/gitSeeds.ts the first time a repo is asked about; every commit, merge,
// rebase, reset and push made in the page changes it, and the log, branches, stashes and undo all read it, so they agree.
// Reads live in gitReads.ts, verbs in gitIndex.ts, gitRefs.ts, gitRewrite.ts and gitPush.ts.

/** A file's content in a commit: its text, or the mark of a file git counts nothing for. */
export type Body = string | Binary;

/** One file a commit changed against its first parent; an absent side is a file added or deleted. */
export interface CommitFile {
    readonly path: string;
    readonly before?: Body | undefined;
    readonly after?: Body | undefined;
}

export interface Commit {
    readonly sha: string;
    readonly parents: readonly string[];
    readonly subject: string;
    readonly body: string;
    readonly author: string;
    readonly email: string;
    readonly at: number;
    readonly files: readonly CommitFile[];
}

/** A stash entry: a commit that sits on `base` and belongs to no branch. */
export interface Stash {
    readonly sha: string;
    readonly subject: string;
    readonly branch: string;
    readonly at: number;
    readonly base: string;
    readonly files: readonly CommitFile[];
}

/** One reflog line: where the branch moved to, in git's words. */
export interface Moved {
    readonly sha: string;
    readonly subject: string;
}

export interface Repo {
    readonly id: string;
    readonly commits: Map<string, Commit>;
    readonly branches: Map<string, string>;
    /** Local branch → the remote-tracking branch it follows (`origin/main`). */
    readonly upstreams: Map<string, string>;
    /** The remote's branches as last fetched, by branch name. */
    readonly fetched: Map<string, string>;
    /** What the remote actually holds, which a fetch brings down and a push changes. */
    readonly server: Map<string, string>;
    readonly tags: Map<string, string>;
    readonly pushedTags: Set<string>;
    /** The checked-out branch, or the bare commit HEAD sits on when there is none. */
    head: { branch: string | undefined; detached: string };
    /** Each branch's reflog, newest first. */
    readonly reflog: Map<string, Moved[]>;
    /** Newest first, as `stash@{0}` numbers them. */
    stashes: Stash[];
    operation: GitOperation | undefined;
    readonly hasRemote: boolean;
    /** The commit a seeded halted cherry-pick was picking. */
    readonly halted?: string | undefined;
}

export const REMOTE = `origin`;
const HOUR = 3_600_000;

const AUTHORS = {
    owner: { name: OWNER.name ?? `Ada`, email: OWNER.email },
    teammate: { name: TEAMMATE.name ?? `Grace`, email: TEAMMATE.email },
    // The daemon's own author for everything an agent commits (git-identity.ts).
    agent: { name: `intentic`, email: `agent@intentic.dev` },
} satisfies Record<SeedAuthor, { readonly name: string; readonly email: string }>;

/** Who a commit made in the page is by: the owner pressed the button. */
const OWNER_AUTHOR = AUTHORS.owner;
export const AGENT_AUTHOR = AUTHORS.agent;

// Unique for every commit made in the page: a counter rides along with the text.
let minted = 0;
const mintSha = (text: string): string => {
    minted += 1;
    return shaOf(`${text}:${String(minted)}`);
};

/** A file's content as of a commit: the nearest change to it down the first-parent line. */
export const contentAt = (repo: Repo, sha: string, path: string): Body | undefined => {
    let at = repo.commits.get(sha);
    while (at !== undefined) {
        const file = at.files.find((entry) => entry.path === path);
        if (file !== undefined) {
            return file.after;
        }
        const [parent] = at.parents;
        at = parent === undefined ? undefined : repo.commits.get(parent);
    }
    return undefined;
};

/** Where HEAD stands: the checked-out branch's tip, or the bare commit. Empty in a repo with no commits yet. */
export const tipOf = (repo: Repo): string => (repo.head.branch === undefined ? repo.head.detached : (repo.branches.get(repo.head.branch) ?? ``));

/** Every commit reachable from these tips. */
export const reachable = (repo: Repo, tips: readonly string[]): Set<string> => {
    const seen = new Set<string>();
    const stack = tips.filter((tip) => tip !== ``);
    while (stack.length > 0) {
        const sha = stack.pop() ?? ``;
        if (seen.has(sha) || !repo.commits.has(sha)) {
            continue;
        }
        seen.add(sha);
        stack.push(...(repo.commits.get(sha)?.parents ?? []));
    }
    return seen;
};

export const isAncestor = (repo: Repo, ancestor: string, of: string): boolean => reachable(repo, [of]).has(ancestor);

/** How many commits `from` has that `than` does not. */
export const countAhead = (repo: Repo, from: string, than: string): number => {
    const theirs = reachable(repo, [than]);
    return [...reachable(repo, [from])].filter((sha) => !theirs.has(sha)).length;
};

/** The commits `from` has that `than` does not, oldest first: what a rebase or a pull replays. */
export const onlyIn = (repo: Repo, from: string, than: string): Commit[] => {
    const theirs = reachable(repo, [than]);
    return [...reachable(repo, [from])]
        .filter((sha) => !theirs.has(sha))
        .map((sha) => repo.commits.get(sha))
        .filter((commit) => commit !== undefined)
        .sort((a, b) => a.at - b.at);
};

/** A sha, short or full, a branch, a remote-tracking branch, a tag or HEAD, as the commit it names. */
export const resolveRef = (repo: Repo, ref: string): string | undefined => {
    if (ref === `HEAD`) {
        return tipOf(repo) || undefined;
    }
    const named = repo.branches.get(ref) ?? repo.tags.get(ref) ?? (ref.startsWith(`${REMOTE}/`) ? repo.fetched.get(ref.slice(REMOTE.length + 1)) : undefined);
    if (named !== undefined) {
        return named;
    }
    if (!/^[0-9a-f]{4,40}$/u.test(ref)) {
        return undefined;
    }
    const matches = [...repo.commits.keys()].filter((sha) => sha.startsWith(ref));
    return matches.length === 1 ? matches[0] : undefined;
};

/** Moves a branch and writes the move into its reflog, as every git verb that moves one does. */
export const moveBranch = (repo: Repo, branch: string, sha: string, subject: string): void => {
    repo.branches.set(branch, sha);
    repo.reflog.set(branch, [{ sha, subject }, ...(repo.reflog.get(branch) ?? [])]);
};

/** Moves HEAD: the checked-out branch with it, or the bare commit when there is no branch. */
export const moveHead = (repo: Repo, sha: string, subject: string): void => {
    if (repo.head.branch === undefined) {
        repo.head.detached = sha;
        return;
    }
    moveBranch(repo, repo.head.branch, sha, subject);
};

export interface NewCommit {
    /** A seeded commit's fixed id; a commit made in the page mints its own. */
    readonly sha?: string;
    readonly parents: readonly string[];
    readonly subject: string;
    readonly body?: string;
    readonly author?: { readonly name: string; readonly email: string };
    readonly at?: number;
    /** Each file as the commit leaves it; `undefined` deletes it. Its before side is read off the first parent. */
    readonly files: readonly { readonly path: string; readonly after: Body | undefined }[];
}

/** Records a commit in the graph (no ref moves) and answers it. */
export const addCommit = (repo: Repo, made: NewCommit): Commit => {
    const [parent] = made.parents;
    const author = made.author ?? OWNER_AUTHOR;
    const commit: Commit = {
        sha: made.sha ?? mintSha(`${repo.id}:${made.subject}`),
        parents: [...made.parents],
        subject: made.subject,
        body: made.body ?? ``,
        author: author.name,
        email: author.email,
        at: made.at ?? Date.now(),
        files: made.files.map(({ path, after }) => ({ path, before: parent === undefined ? undefined : contentAt(repo, parent, path), after })),
    };
    repo.commits.set(commit.sha, commit);
    return commit;
};

const EMPTY_SEED: RepoSeed = { commits: [], head: `main`, branches: {} };

const seedOf = (repo: string): RepoSeed => (freshEdition ? EMPTY_SEED : ((deskEdition ? deskSeed(repo) : shopSeed(repo)) ?? EMPTY_SEED));

const seedCommits = (repo: Repo, seed: RepoSeed): Map<string, string> => {
    const shas = new Map<string, string>();
    let previous: string | undefined;
    for (const seeded of seed.commits) {
        const parents = (seeded.parents ?? (previous === undefined ? [] : [previous])).map((id) => shas.get(id) ?? ``).filter((sha) => sha !== ``);
        const files = Object.entries(seeded.files).map(([path, body]) => {
            const before = parents[0] === undefined ? undefined : contentAt(repo, parents[0], path);
            return { path, after: applyBody(body, before) };
        });
        const made: NewCommit = { sha: seedSha(repo.id, seeded.id), parents, subject: seeded.subject, author: AUTHORS[seeded.by], at: STARTED_AT - seeded.hoursAgo * HOUR, files };
        const commit = addCommit(repo, seeded.body === undefined ? made : { ...made, body: seeded.body });
        shas.set(seeded.id, commit.sha);
        previous = seeded.id;
    }
    return shas;
};

// A seeded branch's reflog: the commit that made its tip, and where it stood before, so the last commit can be undone.
const seedReflog = (repo: Repo, branch: string, tip: string): void => {
    const commit = repo.commits.get(tip);
    const [parent] = commit?.parents ?? [];
    const made = (subject: string, merge: boolean): string => `commit${merge ? ` (merge)` : ``}: ${subject}`;
    const moves: Moved[] = [{ sha: tip, subject: made(commit?.subject ?? ``, (commit?.parents.length ?? 0) > 1) }];
    if (parent !== undefined) {
        moves.push({ sha: parent, subject: made(repo.commits.get(parent)?.subject ?? ``, false) });
    }
    repo.reflog.set(branch, moves);
};

const mapped = (entries: Readonly<Record<string, string>> | undefined, shas: Map<string, string>): Map<string, string> =>
    new Map(Object.entries(entries ?? {}).flatMap(([name, id]) => (shas.has(id) ? [[name, shas.get(id) ?? ``]] : [])));

const build = (id: string, seed: RepoSeed): Repo => {
    const repo: Repo = {
        id,
        commits: new Map(),
        branches: new Map(),
        upstreams: new Map(Object.entries(seed.upstreams ?? {})),
        fetched: new Map(),
        server: new Map(),
        tags: new Map(),
        pushedTags: new Set(seed.pushedTags ?? []),
        head: { branch: seed.head, detached: `` },
        reflog: new Map(),
        stashes: [],
        operation: undefined,
        hasRemote: seed.server !== undefined,
    };
    const shas = seedCommits(repo, seed);
    const halted = seed.halted === undefined ? undefined : shas.get(seed.halted);
    for (const [name, sha] of mapped(seed.branches, shas)) {
        repo.branches.set(name, sha);
        seedReflog(repo, name, sha);
    }
    for (const [target, source] of [
        [repo.fetched, seed.fetched],
        [repo.server, seed.server],
        [repo.tags, seed.tags],
    ] as const) {
        for (const [name, sha] of mapped(source, shas)) {
            target.set(name, sha);
        }
    }
    repo.stashes = (seed.stashes ?? []).map((stash) => {
        const base = shas.get(stash.on) ?? ``;
        const files = Object.entries(stash.files).map(([path, body]) => {
            const before = contentAt(repo, base, path);
            return { path, before, after: applyBody(body, before) };
        });
        return { sha: seedSha(id, `stash:${stash.subject}`), subject: stash.subject, branch: stash.branch, at: STARTED_AT - stash.hoursAgo * HOUR, base, files };
    });
    return { ...repo, halted };
};

const graphs = new Map<string, Repo>();

/** What else a repo's seed sets up once its graph exists (gitPending.ts puts a halted operation's conflict in the tree). */
export const afterBuild: ((repo: Repo) => void)[] = [];

/** The repo's graph, built on first ask. An id the workspace has no repo for is the daemon's NOT_FOUND. */
export const graphOf = (id: string): Repo => {
    const key = `${viewKey()}\0${id}`;
    const known = graphs.get(key);
    if (known !== undefined) {
        return known;
    }
    if (id !== `root` && !REPOS.includes(id)) {
        return refuse(`unknown repo`, 404);
    }
    const seed = seedOf(id);
    const built = build(id, seed);
    const view = gitView();
    if (view?.branch !== undefined && built.branches.has(view.branch)) { built.head = { branch: view.branch, detached: `` }; }
    graphs.set(key, built);
    for (const hook of afterBuild) {
        hook(built);
    }
    return built;
};

/** Tells every open window this repo's refs moved, as the daemon's ref watcher does: logs, branches, Changes re-read. */
export const refsMoved = (repo: string): void => {
    for (const listener of listeners) {
        listener({ kind: `refsChanged`, repos: [repo] });
    }
};
