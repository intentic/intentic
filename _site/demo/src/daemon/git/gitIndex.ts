import { gitView, viewKey } from "./gitView";
import type { CommitResult, GitChange, GitChanges, GitScope, GitTarget, RepoChanges } from "@intentic/sandbox-contract/schemas/git/git";
import type { IndexRun, IndexRunStart } from "@intentic/sandbox-contract/schemas/git/index-run";
import { UNATTRIBUTED_ORIGIN } from "@intentic/sandbox-contract/schemas/git/git";
import { BINARY } from "../../fixture/git/gitSeeds";
import { fileDiff, REPOS, worktreeChanges } from "../../fixture/workspace";
import { addCommit, type Body, graphOf, moveHead, refsMoved, tipOf } from "./gitGraph";
import { remoteState } from "./gitReads";
import { clearPending, movePending, pendingAfter, pendingPaths, withPending } from "./gitPending";

// The index, simulated for one page load: Stage, Unstage, Commit and Discard in the Changes panel move rows the way git
// would, and a commit joins the repo's graph (gitGraph.ts), so the log, the branch's ahead count and undo all see it.
// Nothing on "disk" changes: a committed or discarded file keeps the content the file views read, it just stops being
// pending. Rows a git verb put back into the tree (a soft reset, an applied stash) come from gitPending.ts. A reload
// starts over from the recording.

/** `repo/path` keys staged since load. */
const staged = new Set<string>();
/** `repo/path` keys a commit took or a discard threw away: no longer pending. */
const settled = new Set<string>();

const OK = { ok: true } as const;

/** What a stage or unstage names: paths, a scope, or one origin's chip (GitIndexMoveSchema). */
type IndexMove = GitTarget & { readonly chip?: string | undefined };

const keyOf = (repo: string, path: string): string => `${viewKey()}\0${repo}/${path}`;

// A repo is listed when it has uncommitted work, or when the sync controls have something to do: ahead or behind its
// upstream, a branch never published, or an operation halted (the daemon's own inclusion rule, git.routes.ts).
const isListed = (repo: RepoChanges): boolean => {
    const remote = repo.remote;
    const publishable = repo.branch !== undefined && remote?.remote !== undefined && remote.upstream === undefined;
    const sync = remote !== undefined && (remote.ahead > 0 || remote.behind > 0 || publishable);
    return repo.staged.length + repo.unstaged.length + repo.conflicted.length > 0 || sync || repo.operation !== undefined;
};

// The recording's rows after this page load's index moves, with the branch, the sync position and any halted
// operation read off the graph.
const placed = (repo: RepoChanges): RepoChanges => {
    const keep = (row: GitChange): boolean => !settled.has(keyOf(repo.repo, row.path));
    const rows = [...repo.staged, ...repo.unstaged].filter(keep);
    const graph = graphOf(repo.repo);
    const row: RepoChanges = withPending({
        ...repo,
        staged: rows.filter((change) => staged.has(keyOf(repo.repo, change.path))),
        unstaged: rows.filter((change) => !staged.has(keyOf(repo.repo, change.path))),
        conflicted: repo.conflicted.filter(keep),
        remote: remoteState(repo.repo),
    });
    if (repo.origins !== undefined) {
        row.origins = Object.fromEntries(Object.entries(repo.origins).filter(([path]) => !settled.has(keyOf(repo.repo, path))));
    }
    if (graph.head.branch === undefined) {
        delete row.branch;
    } else {
        row.branch = graph.head.branch;
    }
    if (graph.operation !== undefined) {
        row.operation = graph.operation;
    }
    return row;
};

/** The workspace-wide review as git would report it after this page load's index moves and git verbs. */
export const gitChanges = (): GitChanges => {
    const changes = worktreeChanges();
    const view = gitView();
    const ids = view?.branch === undefined ? [`root`, ...REPOS] : [view.repo ?? `root`];
    const recorded = new Map(changes.repos.map((repo) => [repo.repo, repo]));
    changes.repos = ids
        .map((repo) => placed(recorded.get(repo) ?? { repo, conflicted: [], staged: [], unstaged: [] }))
        .filter((repo) => isListed(repo));
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

// A path a git verb put back is moved on its own row; the recording's rows by the staged set.
const moveIndex = (repo: string, paths: readonly string[], side: `staged` | `unstaged`): void => {
    const mine = new Set(pendingPaths(repo));
    movePending(
        repo,
        paths.filter((path) => mine.has(path)),
        side,
    );
    for (const path of paths.filter((entry) => !mine.has(entry))) {
        if (side === `staged`) {
            staged.add(keyOf(repo, path));
        } else {
            staged.delete(keyOf(repo, path));
        }
    }
};

export const stage = (repo: string, target: IndexMove) => {
    // A conflicted path is staged to mark it resolved, so a plain stage reaches that side too.
    moveIndex(repo, [...resolve(repo, target, `unstaged`), ...(target.paths === undefined ? pendingPaths(repo, `conflicted`) : [])], `staged`);
    return OK;
};

// A chip's unstage takes back what its stage moved; the recording's index starts empty, so that is the origin's rows.
export const unstage = (repo: string, target: IndexMove) => {
    const scoped = target.chip !== undefined ? { scope: { origin: target.chip, side: `staged` as const } } : target;
    moveIndex(repo, resolve(repo, scoped, `staged`), `unstaged`);
    return OK;
};

// What a commit records for a file: a row a git verb made keeps its own content, the recording's rows read its diff.
const committedBody = (repo: string, change: GitChange): Body | undefined => {
    const made = pendingAfter(repo, change.path);
    if (made !== undefined) {
        return made.after;
    }
    if (change.status === `deleted`) {
        return undefined;
    }
    const diff = fileDiff(repo, change.path);
    return diff.binary === true ? BINARY : (diff.after ?? ``);
};

// The staged rows become a commit on the checked-out branch, written in its reflog the way `git commit` writes it.
const record = (repo: string, message: string, taken: readonly GitChange[]): void => {
    const graph = graphOf(repo);
    const head = tipOf(graph);
    const [subject = message, ...rest] = message.split(`\n`);
    const made = addCommit(graph, {
        parents: head === `` ? [] : [head],
        subject,
        body: rest.join(`\n`).trim(),
        files: taken.map((change) => ({ path: change.path, after: committedBody(repo, change) })),
    });
    moveHead(graph, made.sha, `commit${head === `` ? ` (initial)` : ``}: ${subject}`);
    clearPending(
        repo,
        taken.map((change) => change.path),
    );
    refsMoved(repo);
};

/** Records whatever is staged (after staging `stageFirst`, when given) and answers the repo as it now stands. */
export const commit = (repo: string, message: string, stageFirst: GitTarget | undefined): CommitResult => {
    if (stageFirst !== undefined) {
        stage(repo, stageFirst);
    }
    const taken = repoNow(repo)?.staged ?? [];
    if (taken.length > 0) {
        record(repo, message, taken);
    }
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
export const startIndexRun = ({ repo, op, target, message }: IndexRunStart): IndexRun => {
    runCount += 1;
    const now = Date.now();
    const run: IndexRun = { status: `passed`, id: `demo-run-${String(runCount)}`, repo, op, command: `git ${op === `stage` ? `add` : `commit`}`, startedAt: now, finishedAt: now, output: `` };
    if (op === `commit`) {
        run.result = commit(repo, message ?? `Update ${repo}`, target);
    } else {
        stage(repo, target ?? {});
    }
    runs.set(`${viewKey()}\0${repo}`, run);
    return run;
};

export const indexRunState = (repo: string): IndexRun => runs.get(`${viewKey()}\0${repo}`) ?? { status: `idle`, id: ``, repo, command: ``, output: `` };

export const discard = (repo: string, target: GitTarget) => {
    const paths = resolve(repo, target);
    for (const path of paths) {
        const key = keyOf(repo, path);
        settled.add(key);
        staged.delete(key);
    }
    clearPending(repo, paths);
    return OK;
};

/** A hard reset or a checkout that reshapes the tree: every pending row of the repo goes, as `git reset --hard` takes it. */
export const settleAll = (repo: string): void => {
    for (const row of [...(repoNow(repo)?.staged ?? []), ...(repoNow(repo)?.unstaged ?? [])]) {
        settled.add(keyOf(repo, row.path));
        staged.delete(keyOf(repo, row.path));
    }
    clearPending(repo);
};

/** A land rewrites these root-relative paths, so they are pending again even where a commit had taken them. */
export const reopen = (paths: readonly string[]): void => {
    for (const path of paths) {
        settled.delete(`${viewKey()}\0${path}`);
    }
};

/** Which recording rows are pending right now, as `repo/path` keys: what a checkpoint records of the tree. */
export const pendingKeys = (): Set<string> =>
    new Set(gitChanges().repos.flatMap((repo) => [...repo.staged, ...repo.unstaged, ...repo.conflicted].map((row) => `${repo.repo}/${row.path}`)));

/** Puts the tree back to a checkpoint's pending set: rows it held come back, rows it did not are settled. */
export const restorePending = (keys: ReadonlySet<string>, recorded: ReadonlySet<string>): void => {
    for (const key of recorded) {
        if (keys.has(key)) {
            settled.delete(`${viewKey()}\0${key}`);
        } else {
            settled.add(`${viewKey()}\0${key}`);
            staged.delete(`${viewKey()}\0${key}`);
        }
    }
};

/** Every path with uncommitted work in a repo, on any side: what a stash apply refuses to overwrite. */
export const dirtyPaths = (repo: string): Set<string> => {
    const row = repoNow(repo);
    return new Set([...(row?.staged ?? []), ...(row?.unstaged ?? []), ...(row?.conflicted ?? [])].map((change) => change.path));
};
