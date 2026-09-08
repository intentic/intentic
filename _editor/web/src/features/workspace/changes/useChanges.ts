import { errorMessage } from "@intentic/ui/async";
import type {
    CommitResult,
    FileDiffResponse,
    GitActionResult,
    GitChangesResponse,
    GitDiffSide,
    GitTarget,
    OriginAgent,
    RepoChanges,
    RepoTarget,
} from "@intentic/api-contract";
import type { PushRun } from "@intentic/sandbox-contract";
import { computed, ref, watch } from "vue";
import { useChat } from "../../chat/run/useChat";
import { queryClient, UNPERSISTED } from "../../../lib/queryPersistence";
import { throttleTrailing } from "../../../lib/throttleTrailing";
import { sandboxJson } from "../../sandbox/client/sandboxClient";
import { jsonBody } from "../../sandbox/client/jsonBody";
import { useSandboxQuery } from "../../sandbox/client/useSandboxQuery";
import { useRole } from "../../sandbox/secrets/useRole";
import { refusalSummary } from "../health/fixProposal";
import { outgoingWork } from "../push/outgoingWork";
import { spliceRepoChanges } from "./spliceRepoChanges";
import { truncatedTotal } from "./truncation";
import { resetEditBuffers } from "../files/useEditBuffers";
import { usePushRun } from "../push/usePushRun";
import { AGENT_DIFF, GIT_CHANGES, GIT_LOG, HISTORY_SNAPSHOTS, WORKSPACE_TREE } from "../../../lib/queryKeys";

// VSCode's SCM model over real repos: `staged` is index-vs-HEAD, `unstaged` is worktree-vs-index; a path can be on
// both.
// No partial commit — a subset is staged, then the whole index is recorded, since git has one selection mechanism
// already.
// No client watermark: the reviewed line is the commit boundary. Module-level singletons so badge, panel and workspace
// agree.

// Refreshes the review and timeline when any turn ends, across every conversation, not just the active tab's.
// Kept at module scope, not inside useChanges(), since a watch there dies when the shell component unmounts.
const { conversations } = useChat();
const turnsRunning = computed(() => conversations.value.filter((conversation) => conversation.streaming.value).length);
// Throttled: several agents ending turns at once would otherwise trigger a rescan each, collapsed into one.
// Same window as the file-watcher's own refresh (systemEvents).
const TURN_END_REFRESH_MS = 1000;
const refreshReviewable = throttleTrailing(() => {
    void queryClient.invalidateQueries({ queryKey: GIT_CHANGES.every });
    void queryClient.invalidateQueries({ queryKey: HISTORY_SNAPSHOTS.every });
}, TURN_END_REFRESH_MS);
watch(turnsRunning, (now, was) => {
    if (now < was) {
        refreshReviewable();
    }
});

// Every mutation here reports through runBatch: one busy span, and a failure filed under its own scope (a repo,
// or COMMIT_SCOPE) rather than one shared panel-wide error line.
export interface ActionFailure {
    // The verb that failed, in the user's terms ("Fetch failed", "Discard failed").
    readonly action: string;
    // git's own account of why, verbatim.
    readonly detail: string;
    // The settled push run, when the verb was a push; absent for every other verb, which fails inside its own request.
    readonly run?: PushRun;
}

// Thrown when a push settles red, so the batch below files its run alongside the failure message.
class PushRefused extends Error {
    constructor(readonly run: PushRun) {
        super(refusalSummary(run));
    }
}

// The commit box spans every repo, so its failures cannot belong to any one of them.
export const COMMIT_SCOPE = `commit`;

interface ScopedTask {
    readonly scope: string;
    readonly action: string;
    readonly run: () => Promise<void>;
}

const actionBusy = ref(false);
const failures = ref<ReadonlyMap<string, ActionFailure>>(new Map());
// Signed-in member's tier on the active sandbox, read once for the module; runBatch checks it before sending.
const { canShip } = useRole();

// Repos this tab is committing right now, set before the request leaves; unioned with the daemon's own answer below.
const committingHere = ref<readonly string[]>([]);

const dismissFailure = (scope: string): void => {
    if (!failures.value.has(scope)) {
        return;
    }
    const next = new Map(failures.value);
    next.delete(scope);
    failures.value = next;
};

// Runs per-scope tasks concurrently under one busy span; a failure is filed per scope without cancelling the rest.
// `settle` runs unawaited, since holding busy across a slow rescan would freeze the panel with no explanation.
const runBatch = async (tasks: readonly ScopedTask[], settle: () => Promise<unknown>): Promise<void> => {
    if (actionBusy.value) {
        return;
    }
    // A member below maintainer tier is refused here, before anything is sent, filed as an ordinary per-scope failure.
    if (!canShip.value) {
        failures.value = new Map([
            ...failures.value,
            ...tasks.map((task): [string, ActionFailure] => [
                task.scope,
                { action: task.action, detail: `Your access to this sandbox is read-only: this needs maintainer access.` },
            ]),
        ]);
        return;
    }
    actionBusy.value = true;
    // Clears every scope up front, not per task, so a second repo committing under COMMIT_SCOPE doesn't erase the
    // first's failure.
    const scopes = new Set(tasks.map((task) => task.scope));
    failures.value = new Map([...failures.value].filter(([scope]) => !scopes.has(scope)));
    try {
        await Promise.all(
            tasks.map(async (task) => {
                try {
                    await task.run();
                } catch (caught) {
                    failures.value = new Map(failures.value).set(task.scope, {
                        action: task.action,
                        detail: errorMessage(caught, `git gave no reason.`),
                        ...(caught instanceof PushRefused ? { run: caught.run } : {}),
                    });
                }
            }),
        );
    } finally {
        actionBusy.value = false;
    }
    void settle();
};

// One row's diff: `side` is required since a partially staged file has different staged/unstaged content.
// Filed under the change list's own key, so any invalidation that refreshes the list drops its diffs too —
// staleTime is Infinity because only a write can make a diff wrong, not time. Unpersisted: two full file texts.
const FILE_DIFF_GC_MS = 5 * 60 * 1000;

export const fileDiffKey = (repo: string, path: string, side: GitDiffSide): unknown[] => [
    ...GIT_CHANGES.of(),
    UNPERSISTED,
    `file-diff`,
    repo,
    side,
    path,
];

// Named apart from the fetcher below so a background loader can be handed the query object directly.
export const fileDiffQuery = (repo: string, path: string, side: GitDiffSide) => ({
    queryKey: fileDiffKey(repo, path, side),
    queryFn: (): Promise<FileDiffResponse> =>
        sandboxJson<FileDiffResponse>(`/git/${encodeURIComponent(repo)}/file-diff?path=${encodeURIComponent(path)}&side=${side}`),
    staleTime: Infinity,
    gcTime: FILE_DIFF_GC_MS,
    // No retry: a daemon hiccup during read-ahead would otherwise multiply requests; a failed read simply isn't cached.
    retry: false as const,
});

// Wraps the query above in fetchQuery; the panel is the only caller, the loader uses the query object directly.
const fileDiff = (repo: string, path: string, side: GitDiffSide): Promise<FileDiffResponse> =>
    queryClient.fetchQuery(fileDiffQuery(repo, path, side));

// Named apart from the composable that reads it, so the loader can warm the same cache entry (also the diff keys'
// shared prefix).
export const changesKey = (): unknown[] => GIT_CHANGES.of();

export const fetchChanges = (): Promise<GitChangesResponse> => sandboxJson<GitChangesResponse>(`/git/changes`);

// Invalidates the change list and every agent-diff query, since committing or discarding changes what an
// agent's review reads even though no ref moved. Fired directly, not left to the throttled file-watcher pass.
const invalidateChanges = (): Promise<void> =>
    Promise.all([
        queryClient.invalidateQueries({ queryKey: changesKey() }),
        queryClient.invalidateQueries({ predicate: (query) => AGENT_DIFF.matches(query.queryKey) }),
    ]).then(() => undefined);

const post = <T>(repo: string, action: string, body: Record<string, unknown>): Promise<T> =>
    sandboxJson<T>(`/git/${encodeURIComponent(repo)}/${action}`, jsonBody(`POST`, body));

// Two target shapes: `paths` are rows the user picked (limited to what's rendered); `scope` is a description
// the daemon resolves itself. Bulk verbs send a scope, so a truncated review can still act on all of it.
const targetBody = (target: GitTarget): Record<string, unknown> => ({
    ...(target.paths !== undefined ? { paths: target.paths } : {}),
    ...(target.scope !== undefined ? { scope: target.scope } : {}),
});

// Splices the commit's own answer into the cached review; a no-op when the cache is empty, since there's
// nothing yet to splice into. Cancels any in-flight scan first, so a stale read can't overwrite it on arrival.
const applyCommitResult = async (repo: string, result: CommitResult): Promise<void> => {
    const queryKey = changesKey();
    await queryClient.cancelQueries({ queryKey });
    queryClient.setQueryData<GitChangesResponse>(queryKey, (held) => (held === undefined ? held : spliceRepoChanges(held, repo, result)));
};

// One real commit per group (git can't span repos); stageFirst stages the group's target first when nothing's staged
// yet.
// No refetch on the happy path — each commit's own answer is spliced in directly; a refusal falls back to a full read.
const commitRepos = async (groups: readonly RepoTarget[], message: string, stageFirst: boolean): Promise<void> => {
    committingHere.value = groups.map((group) => group.repo);
    try {
        await runBatch(
            groups.map((group) => ({
                scope: COMMIT_SCOPE,
                action: `Commit failed`,
                run: async (): Promise<void> => {
                    const result = await post<CommitResult>(group.repo, `commit`, {
                        message,
                        ...(stageFirst ? { stage: targetBody(group) } : {}),
                    });
                    await applyCommitResult(group.repo, result);
                },
            })),
            () => (failures.value.has(COMMIT_SCOPE) ? invalidateChanges() : Promise.resolve()),
        );
    } finally {
        committingHere.value = [];
    }
};

// Discards a selection: tracked content resets to HEAD, untracked files are deleted; an empty target discards the whole
// repo.
const discardGroups = (groups: readonly RepoTarget[]): Promise<void> =>
    runBatch(
        groups.map((group) => ({
            scope: group.repo,
            action: `Discard failed`,
            run: async (): Promise<void> => {
                await post(group.repo, `discard`, targetBody(group));
            },
        })),
        () => {
            // Stale edit buffers would resurrect discarded files on save; `.every` since the tree's keys don't
            // prefix-match under `.of()`.
            resetEditBuffers();
            return Promise.all([queryClient.invalidateQueries({ queryKey: WORKSPACE_TREE.every }), invalidateChanges()]);
        },
    );

// Ends a halted merge/rebase/cherry-pick/revert left by a terminal; nothing this app runs leaves a repo in
// that state. Checkpointed daemon-side first, since the discarded conflict resolution is real work.
const abortOperation = (repo: string): Promise<void> =>
    runBatch(
        [
            {
                scope: repo,
                action: `Abort failed`,
                run: async (): Promise<void> => {
                    await post(repo, `abort`, {});
                },
            },
        ],
        () => {
            resetEditBuffers();
            return Promise.all([queryClient.invalidateQueries({ queryKey: WORKSPACE_TREE.every }), invalidateChanges()]);
        },
    );

// Index-only move; the worktree is untouched, so unlike discard nothing needs resetting or refetching.
// A group with an empty path list is dropped, since sending it would read as the whole-repo target.
const stageGroups = (groups: readonly RepoTarget[], staged: boolean): Promise<void> =>
    runBatch(
        groups
            .filter((group) => group.paths === undefined || group.paths.length > 0)
            .map((group) => ({
                scope: group.repo,
                action: staged ? `Stage failed` : `Unstage failed`,
                run: async (): Promise<void> => {
                    await post(group.repo, staged ? `stage` : `unstage`, targetBody(group));
                },
            })),
        invalidateChanges,
    );

// Pull is the only sync verb that touches the worktree, so only it resets buffers and refetches the tree.
// Fetch and push move refs the worktree never sees, so they need neither.
const afterPull = async (): Promise<void> => {
    resetEditBuffers();
    await queryClient.invalidateQueries({ queryKey: WORKSPACE_TREE.every });
};

// Fetches every repo with a remote in one busy span, each failing on its own GitActionResult rather than a
// generic error. Pull and push route through the panel's sync door instead, so nothing bypasses the pre-push check.
const fetchRepos = (repos: readonly string[]): Promise<void> =>
    runBatch(
        repos.map((repo) => ({
            scope: repo,
            action: `Fetch failed`,
            run: async (): Promise<void> => {
                const result = await post<GitActionResult>(repo, `fetch`, {});
                if (!result.ok) {
                    // git's own condensed reason; empty falls through to runBatch's generic fallback message.
                    throw new Error(result.reason);
                }
            },
        })),
        () => Promise.all([invalidateChanges(), queryClient.invalidateQueries({ queryKey: GIT_LOG.every })]),
    );

// One busy span with one real sync per repo (git can't span remotes); per repo, pull runs before push so a
// push can't be rejected for commits it could have taken first. Flags come straight off each row's ahead/behind.
export interface SyncTarget {
    readonly repo: string;
    readonly pull: boolean; // True when behind upstream; fast-forwarded before any push.
    readonly push: boolean; // True when ahead, or unpublished; sent (and published, if new) after any pull.
}

const syncAll = (targets: readonly SyncTarget[]): Promise<void> =>
    runBatch(
        targets.map((target) => ({
            scope: target.repo,
            // Names the verb the repo actually needed ("Push failed", not "Sync"), so a push-only failure isn't
            // misnamed.
            action: `${target.pull && target.push ? `Sync` : target.push ? `Push` : `Pull`} failed`,
            run: async (): Promise<void> => {
                if (target.pull) {
                    const pulled = await post<GitActionResult>(target.repo, `pull`, {});
                    if (!pulled.ok) {
                        throw new Error(pulled.reason);
                    }
                    await afterPull();
                }
                if (target.push) {
                    // Followed as a run (usePushRun), not one request, since the pre-push hook can take minutes;
                    // failures carry the run.
                    const pushed = await usePushRun(target.repo).start();
                    if (pushed.status !== `passed`) {
                        throw new PushRefused(pushed);
                    }
                }
            },
        })),
        () => Promise.all([invalidateChanges(), queryClient.invalidateQueries({ queryKey: GIT_LOG.every })]),
    );

// Polls while another tab's (or this tab's pre-reload) commit is running — this tab's own splices in directly.
// Needed since a refused or no-op commit moves no ref, so the ref watcher alone would never end "Committing…".
const COMMIT_WATCH_MS = 1000;

export function useChanges() {
    const { query, error } = useSandboxQuery({
        queryKey: changesKey(),
        queryFn: fetchChanges,
        // Reads the cached response rather than closing over the query it configures.
        refetchInterval: (cached) =>
            committingHere.value.length === 0 && (cached.state.data?.committing?.length ?? 0) > 0 ? COMMIT_WATCH_MS : false,
    });

    // Also includes repos git couldn't scan (empty lists plus an `error`) and repos that are merely out of sync;
    // both contribute 0 to `count` and the panel splits them into their own rows.
    const repos = computed<readonly RepoChanges[]>(() => query.data.value?.repos ?? []);
    // Agent identities come straight off the response, not the fleet roster, since the roster drops archived agents
    // that a landing still names.
    const originAgents = computed<Readonly<Record<string, OriginAgent>>>(() => query.data.value?.originAgents ?? {});
    // Includes conflicts (they block every commit, so an undercount hides exactly the state needing attention)
    // and rows truncated past the per-repo budget: the count is how much work exists, not how much shipped.
    const count = computed(() =>
        repos.value.reduce((total, repo) => total + repo.conflicted.length + repo.staged.length + repo.unstaged.length + truncatedTotal(repo), 0),
    );
    // What a plain Commit would record across every repo; decides the button's "Commit"/"Commit all" label.
    // Includes truncated staged rows too, since the commit records the whole index, not just what's listed.
    const stagedCount = computed(() => repos.value.reduce((total, repo) => total + repo.staged.length + (repo.truncated?.staged ?? 0), 0));
    // What a clean tree still owes its remotes — the count above says nothing about this half.
    const outgoing = computed(() => outgoingWork(repos.value));
    // Union of this tab's own in-flight commits and the daemon's; a repo in either is still being recorded.
    // Committing rows stay listed (dimmed, verbs disabled) rather than assumed gone before the commit returns.
    const committing = computed<readonly string[]>(() => [...new Set([...committingHere.value, ...(query.data.value?.committing ?? [])])]);

    return {
        repos,
        originAgents,
        count,
        committing,
        stagedCount,
        outgoing,
        loading: query.isFetching,
        error,
        refresh: query.refetch,
        fileDiff,
        commitRepos,
        discardGroups,
        abortOperation,
        stageGroups,
        fetchRepos,
        syncAll,
        actionBusy,
        // Keyed by repo id (the per-repo verbs) or COMMIT_SCOPE, the panel renders each one where it happened.
        failures,
        dismissFailure,
    };
}
