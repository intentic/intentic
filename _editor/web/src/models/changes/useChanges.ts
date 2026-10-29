import { invalidatePushedQueries } from "../../lib/pushInvalidation";
import { sandboxRef, sandboxScopeGuard } from "@intentic/extension-api";
import { messageOr, type NoticeModel } from "@intentic/ui/async";
import type {
    PushRun,
    CommitResult,
    GitChanges,
    GitDiffSide,
    GitTarget,
    OriginAgent,
    RepoChanges,
    RepoTarget,
} from "@intentic/sandbox-contract/schemas/git/git";
import type { FileDiff } from "@intentic/sandbox-contract/schemas/history";
import { computed, watch, toValue, type MaybeRefOrGetter } from "vue";
import { isShared, scopeKey, SHARED_SCOPE, type ViewScope } from "../../app/workspaceScope";
import { withinScope } from "../../app/projectScope";
import { useChat } from "../conversations/run/useChat";
import { queryClient, UNPERSISTED } from "../../lib/queryPersistence";
import { throttleTrailing } from "../../lib/throttleTrailing";
import { sandboxRpc } from "../../client/sandbox/sandboxRpc";
import { useSandboxQuery } from "../../client/sandbox/useSandboxQuery";
import { useRole } from "../../client/sandbox/useRole";
import { refusalSummary } from "../workspace/push/refusalSummary";
import { outgoingWork } from "../workspace/push/outgoingWork";
import { landingLine, landingNow } from "./landing";
import { spliceRepoChanges } from "../workspace/changes/spliceRepoChanges";
import { truncatedTotal } from "../workspace/changes/truncation";
import { dropEditBuffers } from "../workspace/files/useEditBuffers";
import { usePushRun } from "../workspace/push/usePushRun";
import { runIndexJob } from "./indexRuns";
import { agentReviewPrefixes, GIT_LOG, rpcKey, rpcPrefix, workingReviewKeys } from "../../lib/queryKeys";
import { t } from "@intentic/ui/i18n";
import { accessWords } from "../../client/sandbox/access/accessWords";
import { dismissOperation, operationAt, startOperation } from "../../workbench/operations/operations";

// VSCode's SCM model over real repos: `staged` is index-vs-HEAD, `unstaged` is worktree-vs-index; a path can be on
// both.
// No partial commit — a subset is staged, then the whole index is recorded, since git has one selection mechanism
// already.
// No client watermark: the reviewed line is the commit boundary. Module-level singletons so badge, panel and workspace
// agree.

// Refreshes the review and timeline when any turn ends, across every conversation, not just the active tab's.
// Kept at module scope, not inside useChanges(), since a watch there dies when the shell component unmounts.
const { conversations } = useChat();
const turnsRunning = computed(() => conversations.value.filter((conversation) => conversation.turn.streaming.value).length);
// Throttled: several agents ending turns at once would otherwise trigger a rescan each, collapsed into one.
// Same window as the file-watcher's own refresh (systemEvents).
const TURN_END_REFRESH_MS = 1000;
const refreshReviewable = throttleTrailing(() => {
    // The timeline is cheap and a land's own commits belong on it; the review is neither, so it waits (see below).
    if (!landingNow.value) {
        for (const queryKey of workingReviewKeys) {
            void invalidatePushedQueries(queryClient, { queryKey });
        }
    }
    void invalidatePushedQueries(queryClient, { queryKey: rpcPrefix(`history.list`) });
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

// Thrown when a push settles as refused, so the batch below files its run alongside the failure message.
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

// A busy span and per-repo failures over one sandbox's repositories; a switch starts the panel clean.
const states = sandboxRef(() => new Map<string, { busy: boolean; failures: ReadonlyMap<string, ActionFailure> }>());
const actionState = (view: ViewScope) => {
    const key = scopeKey(view);
    if (!states.value.has(key)) { states.value.set(key, { busy: false, failures: new Map() }); }
    return states.value.get(key)!;
};
// Signed-in member's tier on the active sandbox, read once for the module; runBatch checks it before sending.
const { canShip } = useRole();

/** What a press said as it was pressed (its label, and the count beside it), which it keeps saying while its work runs. */
export interface PressFace {
    readonly label: string;
    readonly count: number;
}

/**
 * A commit this tab pressed, from before the request leaves until it ends: which repos, and the press as pressed. It is
 * a run in the operations ledger like every other press whose work outlives a glance (COMMIT_RUN), carried as that
 * run's progress, so the repos dimmed, the bar's line and the button's face are all read from the one record, never
 * held apart (a face held by a computed's previous value, a line suppressed by a flag another component emitted), and a
 * second press while one runs is refused by the ledger instead of clearing the first one's record when it ends.
 */
export interface CommitPress {
    readonly repos: readonly string[];
    readonly face: PressFace;
    readonly viewKey?: string;
}
// The ledger's key for this sandbox's commit; the ledger stamps it with the sandbox it began on.
export const COMMIT_RUN = `changes/commit`;
const commitRunKey = (view: ViewScope): string => `${COMMIT_RUN}${isShared(view) ? `` : `/${scopeKey(view)}`}`;
const commitPress = (view: ViewScope): CommitPress | undefined => {
    const run = operationAt<void, NoticeModel, CommitPress>(commitRunKey(view));
    return run?.state === `running` ? run.progress : undefined;
};

const dismissFailure = (scope: string, view: ViewScope): void => {
    const state = actionState(view);
    if (!state.failures.has(scope)) {
        return;
    }
    const next = new Map(state.failures);
    next.delete(scope);
    state.failures = next;
};

// Runs per-scope tasks concurrently under one busy span; a failure is filed per scope without cancelling the rest.
// `settle` runs unawaited, since holding busy across a slow rescan would freeze the panel with no explanation.
const runBatch = async (tasks: readonly ScopedTask[], settle: () => Promise<unknown>, view: ViewScope): Promise<void> => {
    const state = actionState(view);
    if (state.busy) {
        return;
    }
    // A member below maintainer tier is refused here, before anything is sent, filed as an ordinary per-scope failure in
    // the words every access refusal uses. The save panel offers them none of these presses (SavePanel.vue).
    if (!canShip.value) {
        state.failures = new Map([
            ...state.failures,
            ...tasks.map((task): [string, ActionFailure] => [
                task.scope,
                { action: task.action, detail: accessWords({ kind: `tier`, floor: `maintainer` }).note },
            ]),
        ]);
        return;
    }
    state.busy = true;
    // Clears every scope up front, not per task, so a second repo committing under COMMIT_SCOPE doesn't erase the
    // first's failure.
    const scopes = new Set(tasks.map((task) => task.scope));
    state.failures = new Map([...state.failures].filter(([scope]) => !scopes.has(scope)));
    // A batch outlasting a switch reports to nobody: its failures, its busy span and its settling (dropping buffers,
    // rescanning) were the outgoing sandbox's.
    const current = sandboxScopeGuard();
    try {
        await Promise.all(
            tasks.map(async (task) => {
                try {
                    await task.run();
                } catch (caught) {
                    if (current()) {
                        state.failures = new Map(state.failures).set(task.scope, {
                            action: task.action,
                            detail: messageOr(caught, t(`workspace.useChanges.gitGaveNoReason`)),
                            ...(caught instanceof PushRefused ? { run: caught.run } : {}),
                        });
                    }
                }
            }),
        );
    } finally {
        if (current()) {
            state.busy = false;
        }
    }
    if (current()) {
        void settle();
    }
};

// One row's diff: `side` is required since a partially staged file has different staged/unstaged content.
// Goes stale only with the change list (workingReviewKeys invalidates both together) — staleTime is Infinity because
// only a write can make a diff wrong, not time. Unpersisted: two full file texts.
const FILE_DIFF_GC_MS = 5 * 60 * 1000;

export const fileDiffKey = (repo: string, path: string, side: GitDiffSide, view: ViewScope = SHARED_SCOPE): unknown[] => rpcKey(`git.fileDiff`, { repo, path, side, ...(!isShared(view) ? { view } : {}) }, UNPERSISTED);

// Named apart from the fetcher below so a background loader can be handed the query object directly.
export const fileDiffQuery = (repo: string, path: string, side: GitDiffSide, view: ViewScope = SHARED_SCOPE) => ({
    queryKey: fileDiffKey(repo, path, side, view),
    queryFn: (): Promise<FileDiff> => sandboxRpc.git.fileDiff({ repo, path, side }, { context: { gitView: view } }),
    staleTime: Infinity,
    gcTime: FILE_DIFF_GC_MS,
    // No retry: a daemon hiccup during read-ahead would otherwise multiply requests; a failed read simply isn't cached.
    retry: false as const,
});

// Wraps the query above in fetchQuery; the panel is the only caller, the loader uses the query object directly.
const fileDiff = (repo: string, path: string, side: GitDiffSide, view: ViewScope = SHARED_SCOPE): Promise<FileDiff> => queryClient.fetchQuery(fileDiffQuery(repo, path, side, view));

// Named apart from the composable that reads it, so the loader can warm the same cache entry.
export const changesKey = (view: ViewScope = SHARED_SCOPE): unknown[] => rpcKey(`git.changes`, isShared(view) ? undefined : { view });

export const fetchChanges = (view: ViewScope = SHARED_SCOPE): Promise<GitChanges> => isShared(view) ? sandboxRpc.git.changes() : sandboxRpc.git.viewChanges({ view });

// Invalidates the change list, its file diffs, and every agent's review: committing or discarding changes what a review
// reads though no ref moved. Fired directly, not left to the throttled file-watcher pass.
const invalidateChanges = (): Promise<void> =>
    Promise.all([...workingReviewKeys, ...agentReviewPrefixes].map((queryKey) => queryClient.invalidateQueries({ queryKey }))).then(() => undefined);

// A land applying to the tree is the one moment a rescan is both wrong and expensive: the patch is half in, and the
// scan it would run fights the land for git subprocesses. Both refresh paths park on `landingNow`, and this is what
// ends the pause — for a land nobody in this browser asked for as much as for one somebody pressed.
watch(landingNow, (now, was) => {
    if (was && !now) {
        void Promise.all([...workingReviewKeys, ...agentReviewPrefixes].map((queryKey) => invalidatePushedQueries(queryClient, { queryKey })));
    }
});

// Two target shapes: `paths` are rows the user picked (limited to what's rendered); `scope` is a description
// the daemon resolves itself. Bulk verbs send a scope, so a truncated review can still act on all of it.
const targetBody = (target: GitTarget): GitTarget => {
    const body: GitTarget = {};
    if (target.paths !== undefined) { body.paths = target.paths; }
    if (target.scope !== undefined) { body.scope = target.scope; }
    return body;
};

// Splices the commit's own answer into the cached review; a no-op when the cache is empty, since there's
// nothing yet to splice into. Cancels any in-flight scan first, so a stale read can't overwrite it on arrival.
const applyCommitResult = async (repo: string, result: CommitResult, view: ViewScope): Promise<void> => {
    const queryKey = changesKey(view);
    await queryClient.cancelQueries({ queryKey });
    queryClient.setQueryData<GitChanges>(queryKey, (held) => (held === undefined ? held : spliceRepoChanges(held, repo, result)));
};

// One real commit per group (git can't span repos); stageFirst stages the group's target first when nothing's staged
// yet. Each is a commit run (indexRuns.ts), not one request: a stage-first over a dependency tree outlives the header
// deadline, and the run's guardrail asks before a commit would sweep thousands of files into history.
// No refetch on the happy path — each commit's own answer is spliced in directly; a refusal falls back to a full read.
// Answers whether any repo recorded a commit: a "Commit all" over nothing but scratch stages nothing, and git's
// `committed: false` is then the only sign the typed message went nowhere.
const commitRepos = async (groups: readonly RepoTarget[], message: string, stageFirst: boolean, face: PressFace, view: ViewScope = SHARED_SCOPE): Promise<boolean> => {
    let recorded = false;
    const key = commitRunKey(view);
    const ended = await startOperation<void, NoticeModel, CommitPress>(key, {
        what: t(`workspace.useChanges.committing`),
        progress: { repos: groups.map((group) => group.repo), face, viewKey: scopeKey(view) },
        // runBatch files a commit's failure under COMMIT_SCOPE, where the panel draws it; the run itself never throws.
        failed: t(`workspace.useChanges.commitFailed`),
        // The panel is where a commit ends, and its rows say so: no receipt.
        quiet: true,
        task: () =>
            runBatch(
                groups.map((group) => ({
                    scope: COMMIT_SCOPE,
                    action: t(`workspace.useChanges.commitFailed`),
                    run: async (): Promise<void> => {
                        const run = await runIndexJob(
                            group.repo,
                            stageFirst ? { op: `commit`, message, target: targetBody(group) } : { op: `commit`, message },
                            view,
                        );
                        // A passed commit run carries the commit route's own answer.
                        const result = run.result ?? { committed: false };
                        recorded ||= result.committed;
                        await applyCommitResult(group.repo, result, view);
                    },
                })),
                () => (actionState(view).failures.has(COMMIT_SCOPE) ? invalidateChanges() : Promise.resolve()),
                view,
            ),
    });
    // Put away once read here: the press is over. Only this run, should another sandbox be on screen by now.
    if (ended !== undefined && operationAt(key) === ended) {
        dismissOperation(key);
    }
    return recorded;
};

// Discards a selection: tracked content resets to HEAD, untracked files are deleted; an empty target discards the whole
// repo.
const discardGroups = (groups: readonly RepoTarget[], view: ViewScope = SHARED_SCOPE): Promise<void> =>
    runBatch(
        groups.map((group) => ({
            scope: group.repo,
            action: t(`workspace.useChanges.discardFailed`),
            run: async (): Promise<void> => {
                await sandboxRpc.git.discard({ repo: group.repo, ...targetBody(group) }, { context: { gitView: view } });
            },
        })),
        () => {
            // Stale edit buffers would resurrect discarded files on save; the tree's whole prefix, since its scope is
            // part of its key.
            dropEditBuffers(view);
            return Promise.all([queryClient.invalidateQueries({ queryKey: rpcPrefix(`workspace.tree`) }), invalidateChanges()]);
        },
        view,
    );

// Ends a halted merge/rebase/cherry-pick/revert left by a terminal; nothing this app runs leaves a repo in
// that state. Checkpointed daemon-side first, since the discarded conflict resolution is real work.
const abortOperation = (repo: string, view: ViewScope = SHARED_SCOPE): Promise<void> =>
    runBatch(
        [
            {
                scope: repo,
                action: t(`workspace.useChanges.abortFailed`),
                run: async (): Promise<void> => {
                    await sandboxRpc.git.abort({ repo }, { context: { gitView: view } });
                },
            },
        ],
        () => {
            dropEditBuffers(view);
            return Promise.all([queryClient.invalidateQueries({ queryKey: rpcPrefix(`workspace.tree`) }), invalidateChanges()]);
        },
        view,
    );

// Index-only move; the worktree is untouched, so unlike discard nothing needs resetting or refetching.
// A group with an empty path list is dropped, since sending it would read as the whole-repo target. A described target
// (a side, an origin, the whole repo) stages as a run (indexRuns.ts), since it has no size bound; picked paths are
// bounded by the wire (MAX_ACTION_PATHS) and stay one request.
const stageGroups = (groups: readonly RepoTarget[], staged: boolean, view: ViewScope = SHARED_SCOPE): Promise<void> =>
    runBatch(
        groups
            .filter((group) => group.paths === undefined || group.paths.length > 0)
            .map((group) => ({
                scope: group.repo,
                action: staged ? t(`workspace.useChanges.stageFailed`) : t(`workspace.useChanges.unstageFailed`),
                run: async (): Promise<void> => {
                    if (staged && group.paths === undefined) {
                        await runIndexJob(group.repo, { op: `stage`, target: targetBody(group) }, view);
                        return;
                    }
                    const target = { repo: group.repo, ...targetBody(group) };
                    await (staged ? sandboxRpc.git.stage(target, { context: { gitView: view } }) : sandboxRpc.git.unstage(target, { context: { gitView: view } }));
                },
            })),
        invalidateChanges,
        view,
    );

// An origin chip's reversible move (GitIndexMove.chip): clearing writes back what the daemon remembers that chip
// replaced, lighting stages the origin's unstaged files and remembers. One task per repo, the clear before the light, so
// swapping chips over a file both landed ends with the new chip's staging.
interface ChipMove {
    readonly origin: string | undefined;
    readonly repos: readonly string[];
}
const swapChip = (clear: ChipMove, light: ChipMove, view: ViewScope = SHARED_SCOPE): Promise<void> => {
    const clearIn = clear.origin === undefined ? [] : clear.repos;
    const lightIn = light.origin === undefined ? [] : light.repos;
    const repos = [...new Set([...clearIn, ...lightIn])];
    if (repos.length === 0) {
        return Promise.resolve();
    }
    return runBatch(
        repos.map((repo) => ({
            scope: repo,
            action: lightIn.includes(repo) ? t(`workspace.useChanges.stageFailed`) : t(`workspace.useChanges.unstageFailed`),
            run: async (): Promise<void> => {
                if (clear.origin !== undefined && clearIn.includes(repo)) {
                    await sandboxRpc.git.unstage({ repo, chip: clear.origin }, { context: { gitView: view } });
                }
                if (light.origin !== undefined && lightIn.includes(repo)) {
                    await sandboxRpc.git.stage({ repo, chip: light.origin }, { context: { gitView: view } });
                }
            },
        })),
        invalidateChanges,
        view,
    );
};

// Pull is the only sync verb that touches the worktree, so only it resets buffers and refetches the tree.
// Fetch and push move refs the worktree never sees, so they need neither.
const afterPull = async (view: ViewScope): Promise<void> => {
    dropEditBuffers(view);
    await queryClient.invalidateQueries({ queryKey: rpcPrefix(`workspace.tree`) });
};

// Fetches every repo with a remote in one busy span, each failing on its own GitActionResult rather than a
// generic error. Pull and push route through the panel's sync door instead, where a refusal becomes a question.
const fetchRepos = (repos: readonly string[], view: ViewScope = SHARED_SCOPE): Promise<void> =>
    runBatch(
        repos.map((repo) => ({
            scope: repo,
            action: t(`workspace.useChanges.fetchFailed`),
            run: async (): Promise<void> => {
                const result = await sandboxRpc.git.fetch({ repo }, { context: { gitView: view } });
                if (!result.ok) {
                    // git's own condensed reason; empty falls through to runBatch's generic fallback message.
                    throw new Error(result.reason);
                }
            },
        })),
        () => Promise.all([invalidateChanges(), queryClient.invalidateQueries({ queryKey: GIT_LOG.every })]),
        view,
    );

// One busy span with one real sync per repo (git can't span remotes); per repo, pull runs before push so a
// push can't be rejected for commits it could have taken first. Flags come straight off each row's ahead/behind.
export interface SyncTarget {
    readonly repo: string;
    readonly pull: boolean; // True when behind upstream; levelled (fast-forward or replay) before any push.
    readonly push: boolean; // True when ahead, or unpublished; sent (and published, if new) after any pull.
}

const syncAll = (targets: readonly SyncTarget[], view: ViewScope = SHARED_SCOPE): Promise<void> =>
    runBatch(
        targets.map((target) => ({
            scope: target.repo,
            // Names the verb the repo actually needed ("Push failed", not "Sync"), so a push-only failure isn't
            // misnamed.
            action:
                target.pull && target.push
                    ? t(`workspace.useChanges.syncFailed`)
                    : target.push
                      ? t(`workspace.useChanges.pushFailed`)
                      : t(`workspace.useChanges.pullFailed`),
            run: async (): Promise<void> => {
                if (target.pull) {
                    const pulled = await sandboxRpc.git.pull({ repo: target.repo }, { context: { gitView: view } });
                    if (!pulled.ok) {
                        throw new Error(pulled.reason);
                    }
                    await afterPull(view);
                }
                if (target.push) {
                    // Followed as a run (usePushRun), not one request, since the pre-push hook can take minutes;
                    // failures carry the run.
                    const pushed = await usePushRun(target.repo, undefined, view).start();
                    if (pushed.status !== `passed`) {
                        throw new PushRefused(pushed);
                    }
                }
            },
        })),
        () => Promise.all([invalidateChanges(), queryClient.invalidateQueries({ queryKey: GIT_LOG.every })]),
        view,
    );

// Polls while another tab's (or this tab's pre-reload) commit is running — this tab's own splices in directly.
// Needed since a refused or no-op commit moves no ref, so the ref watcher alone would never end "Committing…".
const COMMIT_WATCH_MS = 1000;

export function useChanges(view: MaybeRefOrGetter<ViewScope> = SHARED_SCOPE) {
    const press = computed(() => {
        const held = commitPress(toValue(view));
        return (held?.viewKey ?? ``) === scopeKey(toValue(view)) ? held : undefined;
    });
    const { query, error } = useSandboxQuery({
        queryKey: computed(() => changesKey(toValue(view))),
        queryFn: () => fetchChanges(toValue(view)),
        // The gate, not just the invalidations above: with staleTime at 0, opening the panel mid-land would scan on
        // mount alone — the very case this is about. Held data stays on screen under the strip that explains it, and
        // re-enabling is itself a refetch, since stale data fetches the moment a query is allowed to run again.
        enabled: computed(() => !landingNow.value),
        // Reads the cached response rather than closing over the query it configures.
        refetchInterval: (cached) =>
            commitPress(toValue(view)) === undefined && (cached.state.data?.committing?.length ?? 0) > 0 ? COMMIT_WATCH_MS : isShared(toValue(view)) ? false : 10_000,
    });

    // Also includes repos git couldn't scan (empty lists plus an `error`) and repos that are merely out of sync;
    // both contribute 0 to `count` and the panel splits them into their own rows. Narrowed to the open project
    // (app/projectScope.ts), under which the workspace's own repository is outside every project.
    const repos = computed<readonly RepoChanges[]>(() => (query.data.value?.repos ?? []).filter((repo) => withinScope(repo.repo)));
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
    const committing = computed<readonly string[]>(() => [...new Set([...(press.value?.repos ?? []), ...(query.data.value?.committing ?? [])])]);

    return {
        repos,
        originAgents,
        count,
        committing,
        // This tab's commit while it runs, the press as pressed included.
        press,
        stagedCount,
        outgoing,
        // A read is in flight: what the refresh control spins on. True for background refreshes too, so nothing that
        // decides what the panel SAYS may read it — see `loaded`.
        fetching: query.isFetching,
        // An answer has landed and is still held. The panel's empty line is a claim about the tree ("No uncommitted
        // changes."), so it waits for this rather than for `fetching` to fall: a workspace being written to invalidates
        // this query about once a second (systemEvents' CHANGES_REFRESH_MS), which would otherwise blink the settled
        // answer back to the waiting line at that cadence.
        loaded: computed(() => query.data.value !== undefined),
        // Already-phrased line for a land in flight, or undefined. Everything below it in the panel is a claim about
        // the tree, and while this is set the tree is being written, so the claims yield to it rather than sit beside
        // it: what is listed is the tree BEFORE the land, by design, since the review deliberately doesn't rescan
        // mid-land.
        landing: landingLine,
        error,
        refresh: query.refetch,
        fileDiff: (repo: string, path: string, side: GitDiffSide) => fileDiff(repo, path, side, toValue(view)),
        commitRepos: (groups: readonly RepoTarget[], message: string, stageFirst: boolean, face: PressFace) => commitRepos(groups, message, stageFirst, face, toValue(view)),
        discardGroups: (groups: readonly RepoTarget[]) => discardGroups(groups, toValue(view)),
        abortOperation: (repo: string) => abortOperation(repo, toValue(view)),
        stageGroups: (groups: readonly RepoTarget[], staged: boolean) => stageGroups(groups, staged, toValue(view)),
        swapChip: (clear: ChipMove, light: ChipMove) => swapChip(clear, light, toValue(view)),
        fetchRepos: (repoIds: readonly string[]) => fetchRepos(repoIds, toValue(view)),
        syncAll: (targets: readonly SyncTarget[]) => syncAll(targets, toValue(view)),
        actionBusy: computed(() => actionState(toValue(view)).busy),
        // Keyed by repo id (the per-repo verbs) or COMMIT_SCOPE, the panel renders each one where it happened.
        failures: computed(() => actionState(toValue(view)).failures),
        dismissFailure: (scope: string) => dismissFailure(scope, toValue(view)),
    };
}
