import type { CommitResult, GitChange, GitChanges, GitScope, GitTarget, RepoChanges } from "@intentic/sandbox-contract/schemas/git/git";
import type { IndexRun, IndexRunStart } from "@intentic/sandbox-contract/schemas/git/index-run";
import { UNATTRIBUTED_ORIGIN } from "@intentic/sandbox-contract/schemas/git/git";
import { worktreeChanges } from "../fixture/workspace";

// The index, simulated for one page load: Stage, Unstage, Commit and Discard in the Changes panel move rows the way git
// would, so the flow can be tried end to end. Nothing on "disk" changes: a committed or discarded file keeps the content
// the file views read, it just stops being pending. A reload starts over from the recording.

/** `repo/path` keys staged since load. */
const staged = new Set<string>();
/** `repo/path` keys a commit took or a discard threw away: no longer pending. */
const settled = new Set<string>();

const OK = { ok: true } as const;

/** What a stage or unstage names: paths, a scope, or one origin's chip (GitIndexMoveSchema). */
type IndexMove = GitTarget & { readonly chip?: string | undefined };

const keyOf = (repo: string, path: string): string => `${repo}/${path}`;

const isPending = (repo: RepoChanges): boolean => repo.staged.length + repo.unstaged.length + repo.conflicted.length > 0;

/** The workspace-wide review as git would report it after this page load's index moves. */
export const gitChanges = (): GitChanges => {
    const changes = worktreeChanges();
    for (const repo of changes.repos) {
        const keep = (row: GitChange): boolean => !settled.has(keyOf(repo.repo, row.path));
        const rows = [...repo.staged, ...repo.unstaged].filter(keep);
        repo.staged = rows.filter((row) => staged.has(keyOf(repo.repo, row.path)));
        repo.unstaged = rows.filter((row) => !staged.has(keyOf(repo.repo, row.path)));
        repo.conflicted = repo.conflicted.filter(keep);
        if (repo.origins !== undefined) {
            repo.origins = Object.fromEntries(Object.entries(repo.origins).filter(([path]) => !settled.has(keyOf(repo.repo, path))));
        }
    }
    changes.repos = changes.repos.filter(isPending);
    return changes;
};

const repoNow = (repo: string): RepoChanges | undefined => gitChanges().repos.find((row) => row.repo === repo);

const inOrigin = (repo: RepoChanges, path: string, origin: string): boolean => {
    const authors = repo.origins?.[path] ?? [];
    return origin === UNATTRIBUTED_ORIGIN ? authors.length === 0 : authors.includes(origin);
};

/** The repo-relative paths a target names, resolved against the repo's pending rows like the daemon resolves a scope. */
const resolve = (repo: string, target: IndexMove, from?: `staged` | `unstaged`): string[] => {
    const now = repoNow(repo);
    if (now === undefined) {
        return [];
    }
    if (target.paths !== undefined) {
        return [...target.paths];
    }
    const scope: GitScope = target.chip !== undefined ? { origin: target.chip, side: `unstaged` } : (target.scope ?? {});
    const sides = scope.side !== undefined ? [scope.side] : from !== undefined ? [from] : ([`staged`, `unstaged`, `conflicted`] as const);
    return sides
        .flatMap((side) => now[side])
        .map((row) => row.path)
        .filter((path) => scope.origin === undefined || inOrigin(now, path, scope.origin));
};

export const stage = (repo: string, target: IndexMove) => {
    for (const path of resolve(repo, target, `unstaged`)) {
        staged.add(keyOf(repo, path));
    }
    return OK;
};

// A chip's unstage takes back what its stage moved; the recording's index starts empty, so that is the origin's rows.
export const unstage = (repo: string, target: IndexMove) => {
    const scoped = target.chip !== undefined ? { scope: { origin: target.chip, side: `staged` as const } } : target;
    for (const path of resolve(repo, scoped, `staged`)) {
        staged.delete(keyOf(repo, path));
    }
    return OK;
};

/** Records whatever is staged (after staging `stageFirst`, when given) and answers the repo as it now stands. */
export const commit = (repo: string, stageFirst: GitTarget | undefined): CommitResult => {
    if (stageFirst !== undefined) {
        stage(repo, stageFirst);
    }
    const taken = repoNow(repo)?.staged ?? [];
    for (const row of taken) {
        const key = keyOf(repo, row.path);
        settled.add(key);
        staged.delete(key);
    }
    const { repos, originAgents } = gitChanges();
    const result: CommitResult = { committed: taken.length > 0 };
    const changes = repos.find((row) => row.repo === repo);
    if (changes !== undefined) {
        result.changes = changes;
    }
    if (originAgents !== undefined) {
        result.originAgents = originAgents;
    }
    return result;
};

/** Each repo's last stage or commit run: the simulated index moves at once, so a run is settled when it starts. */
const runs = new Map<string, IndexRun>();
let runCount = 0;

/** A stage or commit run (IndexRunSchema), done on the spot and answered already passed; the editor's follow reads it once. */
export const startIndexRun = ({ repo, op, target }: IndexRunStart): IndexRun => {
    runCount += 1;
    const now = Date.now();
    const run: IndexRun = { status: `passed`, id: `demo-run-${String(runCount)}`, repo, op, command: `git ${op === `stage` ? `add` : `commit`}`, startedAt: now, finishedAt: now, output: `` };
    if (op === `commit`) {
        run.result = commit(repo, target);
    } else {
        stage(repo, target ?? {});
    }
    runs.set(repo, run);
    return run;
};

export const indexRunState = (repo: string): IndexRun => runs.get(repo) ?? { status: `idle`, id: ``, repo, command: ``, output: `` };

export const discard = (repo: string, target: GitTarget) => {
    for (const path of resolve(repo, target)) {
        const key = keyOf(repo, path);
        settled.add(key);
        staged.delete(key);
    }
    return OK;
};

/** A land rewrites these root-relative paths, so they are pending again even where a commit had taken them. */
export const reopen = (paths: readonly string[]): void => {
    for (const path of paths) {
        settled.delete(path);
    }
};
