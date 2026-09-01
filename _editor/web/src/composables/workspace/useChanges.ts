import { errorMessage } from "@intentic/ui/async";
import type {
    CommitResult,
    FileDiffResponse,
    GitActionResult,
    GitChangesResponse,
    GitDiffSide,
    OriginAgent,
    RepoChanges,
    RepoPaths,
} from "@intentic-app/api-contract";
import { computed, ref, watch } from "vue";
import { rendersAsBytes } from "../../pages/workspace/fileType";
import { useChat } from "../chat/useChat";
import { queryClient, UNPERSISTED } from "../queryPersistence";
import { throttleTrailing } from "../throttleTrailing";
import { sandboxJson } from "../sandbox/sandboxClient";
import { jsonBody } from "../sandbox/jsonBody";
import { useSandboxQuery } from "../sandbox/useSandboxQuery";
import { outgoingWork } from "./outgoingWork";
import { spliceRepoChanges } from "./spliceRepoChanges";
import { useCodeStats } from "./useCodeStats";
import { resetEditBuffers } from "./useEditBuffers";
import { GIT_CHANGES, GIT_LOG, HISTORY_SNAPSHOTS, WORKSPACE_TREE } from "../queryKeys";

/* The Changes review. VSCode's SCM model over the workspace's real repos, including git's index: each repo
 * reports `staged` (index vs HEAD, what a bare commit would record) and `unstaged` (worktree vs index, plus
 * untracked), because a path can sit on both with different content. "root" (the /work repo itself) plus every
 * discovered repo under it, aggregated by the daemon's /git/changes.
 *
 * VSCode's model all the way down, which means STAGING IS THE SELECTION: `commitRepos` records the index and
 * nothing else. There is no partial commit here (or in the daemon) because git already has one mechanism for
 * choosing a commit's contents and a second one could only contradict it, so when the panel wants a subset,
 * it STAGES that subset and then records the index, which is the same answer said in git's own terms. Discard
 * restores the worktree from HEAD; the remote verbs sync it.
 *
 * No client-side watermark: the reviewed line IS the commit boundary, so every browser and device agrees.
 * Module-level singletons so the badge (shell), the panel, and the workspace agree. */

// A turn ending is when its work becomes reviewable, refresh the review set and the snapshot timeline so the
// badge and panels surface it without a manual refresh. Counted across ALL conversations, not the active tab's
// stream: a background tab's turn lands into the same tree, and watching only the focused one meant the panel
// went stale for exactly the turns the user wasn't watching. Module scope (like sandboxScope.ts), NOT inside
// useChanges(): a watch installed from a component dies with that component's effect scope, and the /setup
// round-trip unmounts the shell that calls useChanges() first. `.every` because a background tab's turn can
// have landed in another sandbox's tree, and only the family-wide prefix reaches it (see queryKeys).
const { conversations } = useChat();
const turnsRunning = computed(() => conversations.value.filter((conversation) => conversation.streaming.value).length);
/* THROTTLED, because "a turn ended" is a per-AGENT event and the read it triggers is workspace-wide. One agent
 * finishing is one refresh either way, throttleTrailing runs the first call on the spot, so the common case
 * stays instant. Four or five agents working at once is where it mattered: their turns end continuously and
 * independently, and each ending fired its own full review scan (every repo, several git spawns each) on the
 * daemon's most contended path. They collapse into one refresh per window now, which is also all the daemon
 * would have served, it coalesces overlapping scans anyway, so the extra rounds bought staleness of zero.
 *
 * Same window as the file-watcher's own refresh (systemEvents), for the same reason: a second of staleness on a
 * review the user is not yet looking at is imperceptible, and it bounds the cost of a busy fleet. */
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

/* --- action state -------------------------------------------------------------------------------------------
 * Every mutation below reports through `runBatch`: one busy span for the whole batch, and any failure filed
 * under the SCOPE the user fired it from, a repo id for the per-repo verbs, COMMIT_SCOPE for the commit box
 * that spans them. Scoped, not panel-wide: a fetch that failed on `intentic` has nothing to say about `root`,
 * and the single shared error line this replaces rendered at the top of the panel naming neither the repo nor
 * the verb, so a failed fetch read as a stray red sentence with no visible cause.
 *
 * The verb is kept apart from git's words for the same reason. "Fetch failed" is what the user needs to read
 * first; `fatal: could not read Username for 'https://github.com'` is the detail underneath it. */
export interface ActionFailure {
    // The verb that failed, in the user's terms, "Fetch failed", "Discard failed".
    readonly action: string;
    // git's own account of why, verbatim.
    readonly detail: string;
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

/* THE REPOS THIS TAB IS COMMITTING RIGHT NOW, beside the daemon's own answer to the same question.
 *
 * Both halves are needed and neither is redundant. This one is instant, it is set before the request leaves,
 * so the button changes on the click rather than a round-trip later. The daemon's (on the changes response)
 * is the one that SURVIVES: a commit outlives the tab that fired it, so a reload, a second tab or a phone
 * learns about it from the daemon or not at all. Unioned at the read below. */
const committingHere = ref<readonly string[]>([]);

const dismissFailure = (scope: string): void => {
    if (!failures.value.has(scope)) {
        return;
    }
    const next = new Map(failures.value);
    next.delete(scope);
    failures.value = next;
};

/* One busy span over a batch of per-scope tasks. A failure is filed against its own scope and the batch CARRIES
 * ON: the repos are independent, so aborting root's discard because intentic's remote is unreachable would
 * strand work the user asked for behind a failure they cannot act on. Re-entry while busy is a no-op, so a
 * double-click fires once. `settle` runs whatever happened, the cache must match the worktree even when only
 * half the batch landed.
 *
 * THE TASKS RUN AT ONCE, because every batch here is one task PER REPO and git cannot span repos: the daemon
 * holds a separate lock per repo and scans them concurrently already, so running them one after another only
 * ever added up their waits. A workspace-wide commit paid that sum in full, six repos, each a stage, a commit
 * and a re-read, the last one starting after the first five had finished, and the whole batch now costs the
 * slowest repo instead. Each task still files its own failure against its own scope, and a rejection cannot
 * escape the wrapper, so one repo failing neither cancels nor is cancelled by the others.
 *
 * THE SPAN COVERS THE WRITES, NOT THE REFRESH. Every button in the panel is disabled off this flag, and `settle`
 * is a refetch of the most expensive read the daemon serves, a workspace-wide rescan that measured seconds
 * under load. Holding the flag across it meant a commit that itself took under two seconds left the whole panel
 * dead for ten, with no spinner to say why; and because nothing on that refetch ever times out, a refresh that
 * never settled disabled the panel until the page was reloaded. That is the "I click Commit and nothing
 * happens" report, and the flag was the thing reporting it.
 *
 * So the refresh is fired and not awaited. Nothing waits on it: `settle`'s synchronous half (dropping edit
 * buffers) still runs before this returns, and the rows it refetches are stale-while-revalidate everywhere else
 * in the app already. The one door this could reopen, committing twice off rows that have not caught up, is
 * shut a second time by the commit box, which clears its message on success and needs one to arm the button. */
const runBatch = async (tasks: readonly ScopedTask[], settle: () => Promise<unknown>): Promise<void> => {
    if (actionBusy.value) {
        return;
    }
    actionBusy.value = true;
    // Clear every scope this batch touches up front rather than per task: several repos committing under the
    // one COMMIT_SCOPE would otherwise have the second repo's start erase the first repo's failure.
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
                    });
                }
            }),
        );
    } finally {
        actionBusy.value = false;
    }
    void settle();
};

/* --- one row's diff -------------------------------------------------------------------------------------------
 * The diff of the ROW that was clicked, not of the file in general: `staged` is index-vs-HEAD, `unstaged` is
 * worktree-vs-index. A partially staged file has both, and they differ, showing one for the other would be a
 * quiet lie, so the side is required rather than defaulted.
 *
 * FILED UNDER THE CHANGE LIST'S OWN KEY, which is the whole freshness rule in one line: every invalidation that
 * refreshes the list drops the diffs with it, the panel's own verbs (below), an agent's write or a terminal's,
 * a ref moving (systemEvents), a turn ending (above), so a cached diff can never be staler than the row that
 * opened it. That is why `staleTime` is Infinity rather than a guessed number of seconds: time is not what makes
 * a diff wrong, a write is, and every write already lands here. During a streaming turn the list deliberately
 * stops refreshing (systemEvents) and these go stale with it, which is the honest behaviour, the rows and the
 * diffs they open describe the same moment either way.
 *
 * UNPERSISTED because a diff is two whole file texts and the warmer below reads one per changed file: see
 * queryPersistence for what putting that in the disk mirror costs. `gcTime` is the memory bound that follows,
 * warmed diffs nobody opened are collected a few minutes after the review moved on.
 *
 * Concurrent callers share one request (fetchQuery dedupes an in-flight fetch per key), which is what lets a
 * click land on a file the warmer is already reading and simply wait for that read instead of racing it. */
const FILE_DIFF_GC_MS = 5 * 60 * 1000;

export const fileDiffKey = (repo: string, path: string, side: GitDiffSide): unknown[] => [
    ...GIT_CHANGES.of(),
    UNPERSISTED,
    `file-diff`,
    repo,
    side,
    path,
];

/* Where this row's code-only +/− is filed (useCodeStats). Scoped to the working tree and to the SIDE, because a
 * path that is staged and then edited again is two rows with two different diffs and two different counts. */
export const workingStatKey = (repo: string, side: GitDiffSide, path: string): string => JSON.stringify([`working`, repo, side, path]);

/* THE COUNT IS A BY-PRODUCT OF THE READ, not of who did the reading.
 *
 * These rows sit beside diffs that open on code alone, so their +/− has to be the code's rather than git's,
 * and working that out needs both whole sides of the file, which is precisely what this read just paid for.
 * Counting HERE rather than in the surface that asked means every path gets it for the same price: the
 * background loader walking the review, the reader clicking a row past where the loader got to, a repeat visit
 * answered from the cache. It used to be the warm walk's job, so a row the walk hadn't reached showed git's
 * number until it was opened AND a second watch existed to catch that case.
 *
 * Bytes and oversized files are WRITTEN OFF rather than left alone. A code-only count needs both whole sides, and
 * neither of those has them: a picture has no text to strip, and an oversized file arrives as a patch of its
 * changed regions, which is an excerpt, so counting it would describe the excerpt rather than the change. Git's
 * own counts stand for both. Written off EXPLICITLY, because a row left unrecorded was indistinguishable from one
 * whose count had simply not been taken yet, which is how a badge ends up printing a number it is about to
 * replace. The store turns away a second ask for content it has already counted, so overlapping callers cost
 * nothing. */
const countDiff = (repo: string, path: string, side: GitDiffSide, body: FileDiffResponse): void => {
    const stats = useCodeStats();
    const key = workingStatKey(repo, side, path);
    if (body.partial !== undefined || rendersAsBytes(path, body.binary)) {
        stats.noCode(key);
        return;
    }
    void stats.record(key, path, body.before ?? ``, body.after ?? ``);
};

/* The query, named apart from the call, so the background loader can be handed the QUERY rather than a function
 * that fetches it, see agentTranscriptQuery for what having those two halves separable cost. */
export const fileDiffQuery = (repo: string, path: string, side: GitDiffSide) => ({
    queryKey: fileDiffKey(repo, path, side),
    queryFn: async (): Promise<FileDiffResponse> => {
        const body = await sandboxJson<FileDiffResponse>(`/git/${encodeURIComponent(repo)}/file-diff?path=${encodeURIComponent(path)}&side=${side}`);
        countDiff(repo, path, side, body);
        return body;
    },
    staleTime: Infinity,
    gcTime: FILE_DIFF_GC_MS,
    // No retry, which is what this read has always done (it was a bare fetch) and what the loader needs it to
    // keep doing: a daemon hiccup during a read-ahead would otherwise turn one quiet walk into four times the
    // requests, which is the burst the pacing exists to avoid. A failure leaves nothing cached, so the click
    // that follows asks again for real.
    retry: false as const,
});

// Module-local: the loader takes the query above rather than a function that runs it, so the panel below is the
// only caller left.
const fileDiff = (repo: string, path: string, side: GitDiffSide): Promise<FileDiffResponse> =>
    queryClient.fetchQuery(fileDiffQuery(repo, path, side));

// The review set itself, named apart from the composable that observes it so the background loader can warm
// the same entry rather than a parallel one. `GIT_CHANGES.of()` is also the PREFIX every file diff
// above is filed under, which is what makes one invalidation drop the list and its diffs together.
export const changesKey = (): unknown[] => GIT_CHANGES.of();

export const fetchChanges = (): Promise<GitChangesResponse> => sandboxJson<GitChangesResponse>(`/git/changes`);

const invalidateChanges = (): Promise<void> => queryClient.invalidateQueries({ queryKey: changesKey() });

const post = <T>(repo: string, action: string, body: Record<string, unknown>): Promise<T> =>
    sandboxJson<T>(`/git/${encodeURIComponent(repo)}/${action}`, jsonBody(`POST`, body));

/* The commit's own answer, folded into the cached review set (the rule itself is spliceRepoChanges). Nothing is
 * written when the cache is empty: there is nothing to splice into, and seeding it here would paint a one-repo
 * review over a panel that has never loaded, the query's own fetch is what fills it.
 *
 * CANCEL FIRST, because a scan can be in flight right now and it started before the commit. The panel refetches
 * on every workspace-change batch and in this product an agent is usually writing, so a review read overlapping
 * a commit is ordinary rather than exotic, and one that resolves after this write lands re-paints the rows the
 * commit just removed, with data that was already stale when it was requested. Cancelling drops that answer
 * instead of letting it win on arrival; a scan that starts AFTER this reads a tree that already has the commit
 * in it, so only the overlap needs handling. */
const applyCommitResult = async (repo: string, result: CommitResult): Promise<void> => {
    const queryKey = changesKey();
    await queryClient.cancelQueries({ queryKey });
    queryClient.setQueryData<GitChangesResponse>(queryKey, (held) => (held === undefined ? held : spliceRepoChanges(held, repo, result)));
};

// Commit. git can't span repos, so each group gets its own real commit on its own branch, all sharing the
// message. `stageFirst` is VSCode's "stage all and commit", for the case where nothing is staged yet, and the
// group says HOW MUCH: the whole repo through the daemon's `all` shape (`git commit -a`, the only reading that
// also reaches rows the daemon truncated past its budget), or exactly the `paths` the panel's origin filter
// narrowed to. Either way the daemon stages inside the repo lock and then records the whole index, never a
// partial commit, which is what keeps it honest about what the rows showed.
//
// Without `stageFirst` the index alone decides, and `paths` is not sent: the panel's target is the staged repos.
//
// NO REFETCH ON THE HAPPY PATH, unlike every other verb here. Each commit answers with its own repo's rows and
// they are spliced in as it lands, so by the time the batch is done the review is already correct, where the
// workspace-wide rescan this replaces re-read every repo the commit never touched, on the daemon's most
// contended path, while the user watched the rows they had just committed sit there. A REFUSED commit is the
// one case with nothing to splice and a repo that may still have moved (`commit -a` stages before it commits),
// so that alone falls back to the full read.
//
// MARKED WHILE IT RUNS, so the panel can say so. The daemon reports the same fact on every changes response and
// the two are unioned at the read, this half is what makes the button change on the click instead of a
// round-trip later, and the daemon's half is what a reloaded tab has instead of this one.
const commitRepos = async (groups: readonly RepoPaths[], message: string, stageFirst: boolean): Promise<void> => {
    committingHere.value = groups.map((group) => group.repo);
    try {
        await runBatch(
            groups.map((group) => ({
                scope: COMMIT_SCOPE,
                action: `Commit failed`,
                run: async (): Promise<void> => {
                    const result = await post<CommitResult>(group.repo, `commit`, {
                        message,
                        ...(!stageFirst ? {} : group.paths === undefined ? { all: true } : { paths: group.paths }),
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

// Discard a selection: tracked content returns to HEAD, untracked files are deleted. A group with no `paths`
// discards the whole repo. Drop edit buffers + refresh the tree (the worktree changed under any open file).
const discardGroups = (groups: readonly RepoPaths[]): Promise<void> =>
    runBatch(
        groups.map((group) => ({
            scope: group.repo,
            action: `Discard failed`,
            run: async (): Promise<void> => {
                await post(group.repo, `discard`, group.paths !== undefined ? { paths: group.paths } : {});
            },
        })),
        () => {
            // Stale buffers would silently resurrect discarded files on save. `.every` for the tree, its keys
            // carry the focused scope before the appended sandbox id, so `.of()` would NOT prefix-match them
            // (see queryKeys).
            resetEditBuffers();
            return Promise.all([queryClient.invalidateQueries({ queryKey: WORKSPACE_TREE.every }), invalidateChanges()]);
        },
    );

/* END A HALTED MERGE, REBASE, CHERRY-PICK OR REVERT, the way out of a repo git will not otherwise act on.
 *
 * Nothing this app starts can leave a repo in that state: every git verb the daemon runs aborts itself on
 * failure. What lands here is what a TERMINAL left, an agent's rebase that stopped on a conflict, a `land` that
 * could not finish, which is exactly the case the panel could previously only describe, by listing conflicted
 * files with no account of why they were conflicted.
 *
 * The abort rewrites the worktree back to where the operation began, so it drops the edit buffers and refetches
 * the tree for the same reason discard does. Checkpointed daemon-side first: the conflict resolution being
 * thrown away is real work.
 */
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

// Index moves. The worktree is untouched, so unlike discard there is nothing to reset or re-read beyond the
// review set itself, no buffer drop, no tree refetch.
const stageGroups = (groups: readonly RepoPaths[], staged: boolean): Promise<void> =>
    runBatch(
        groups
            .filter((group) => group.paths !== undefined && group.paths.length > 0)
            .map((group) => ({
                scope: group.repo,
                action: staged ? `Stage failed` : `Unstage failed`,
                run: async (): Promise<void> => {
                    await post(group.repo, staged ? `stage` : `unstage`, { paths: group.paths });
                },
            })),
        invalidateChanges,
    );

// Pull is the only sync verb that rewrites the worktree, so it is the only one that must drop the edit buffers
// and refetch the tree: a buffer left open over a pulled-away file would save it straight back over the merge on
// the next keystroke. fetch and push move refs the worktree never sees, so they need neither.
const afterPull = async (): Promise<void> => {
    resetEditBuffers();
    await queryClient.invalidateQueries({ queryKey: WORKSPACE_TREE.every });
};

/* What MAKES ahead/behind trustworthy, over every repo the caller names, in one busy span. Each reports a
 * GitActionResult rather than throwing, so a credential failure surfaces as git's own reason filed against the
 * repo that raised it instead of a generic request error.
 *
 * IT TAKES A LIST because that is the scope the panel now asks in. Fetch used to hang off an individual repo
 * row, back when the Changes list carried a sync dashboard on every row; that interleaved a repo surface with a
 * file review, so the sync state moved up into the one block that owns "what is leaving this machine" and the
 * fetch went with it. There is one fetch control and its scope is every repo with a remote, which is also the
 * honest scope: the zero on a repo you did not fetch is exactly the stale claim this verb exists to refresh.
 *
 * NEITHER PULL NOR PUSH IS HERE. Both go through the panel's single sync door (usePushFlow's askSync, then
 * `syncAll` below), because a second way to reach a verb is a way around the pre-push check. A pull-only sync
 * passes that check straight through, so routing it there costs nothing. */
const fetchRepos = (repos: readonly string[]): Promise<void> =>
    runBatch(
        repos.map((repo) => ({
            scope: repo,
            action: `Fetch failed`,
            run: async (): Promise<void> => {
                const result = await post<GitActionResult>(repo, `fetch`, {});
                if (!result.ok) {
                    // git's own reason, which the daemon already condensed to its verdict line. Empty falls
                    // through to runBatch's fallback rather than being papered over with the verb again.
                    throw new Error(result.reason);
                }
            },
        })),
        () => Promise.all([invalidateChanges(), queryClient.invalidateQueries({ queryKey: GIT_LOG.every })]),
    );

// The aggregate the panel's primary button fires once the commit box has nothing left to show: the commits you
// just made are one labelled click from their remote, in the very place you committed them, instead of a muted
// ↑N pill you had to know to hunt for on a repo row. git can't span remotes, so, exactly like commitRepos, this
// is one real sync PER repo under a single busy span, each failure filed against its own repo row. Per repo the
// order is pull-then-push: fast-forward the branch up to its upstream before sending local commits, so a push
// can't be rejected for work we could have taken first. `pull`/`push` come straight off the row's ahead/behind,
// so a repo that needs only one gets only one, and a set whose repos disagree still resolves each on its own.
export interface SyncTarget {
    readonly repo: string;
    readonly pull: boolean; // behind its upstream, fast-forward it first
    readonly push: boolean; // ahead, or a branch with no upstream yet, send (publishing it when unpublished) after
}

const syncAll = (targets: readonly SyncTarget[]): Promise<void> =>
    runBatch(
        targets.map((target) => ({
            scope: target.repo,
            // Name the verb the repo actually needed, so a push-only repo that fails reads "Push failed", not a
            // "Sync" it never attempted. The row's failure line stays as specific as the individual pills'.
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
                    const pushed = await post<GitActionResult>(target.repo, `push`, {});
                    if (!pushed.ok) {
                        throw new Error(pushed.reason);
                    }
                }
            },
        })),
        () => Promise.all([invalidateChanges(), queryClient.invalidateQueries({ queryKey: GIT_LOG.every })]),
    );

/* How often to re-ask while SOMEONE ELSE'S commit is running, a second tab's, or this tab's own from before a
 * reload. The tab that fired the commit needs none of this: its own request answers with the committed rows and
 * splices them.
 *
 * It exists because the alternative is waiting on a ref moving. The panel learns about out-of-band git through
 * the ref watcher, which fires only when a ref actually MOVES, so a commit git refused, or one that turned out
 * to have nothing to record, moved nothing and the panel would have sat reading "Committing…" with no end. The
 * interval matches the ref feed's own refresh throttle, so this costs the daemon no more per second than a
 * workspace being written to already does, and it stops the moment the commit clears. */
const COMMIT_WATCH_MS = 1000;

export function useChanges() {
    const { query, error } = useSandboxQuery({
        queryKey: changesKey(),
        queryFn: fetchChanges,
        // Off the CACHED response rather than a computed, so this cannot close over the query it configures.
        refetchInterval: (cached) =>
            committingHere.value.length === 0 && (cached.state.data?.committing?.length ?? 0) > 0 ? COMMIT_WATCH_MS : false,
    });

    // `repos` also carries the repos git could NOT scan (empty change lists + a one-line `error`; the panel
    // renders them as their own rows) and repos that are merely out of sync with their remote (clean tree,
    // non-zero ahead/behind). They contribute 0 to `count`, which is what every badge wants, a torn or merely
    // unpushed repo has no reviewable work, and the panel, the only consumer that iterates the list, splits
    // them out itself.
    const repos = computed<readonly RepoChanges[]>(() => query.data.value?.repos ?? []);
    // Who the agent ids in `repo.origins` are, straight off the response. The panel does NOT resolve them
    // against the fleet roster alone: that roster is the live board and drops archived agents, while a landing
    // outlives the card, see OriginAgentSchema in the contract for why the identity rides the review instead.
    const originAgents = computed<Readonly<Record<string, OriginAgent>>>(() => query.data.value?.originAgents ?? {});
    // Every reviewable row, including conflicts (they block commits, the badge undercounting exactly the state
    // that needs attention was a bug) and the rows the daemon truncated past its per-repo budget: the badge
    // reports how much work EXISTS, not how much of it got shipped.
    const count = computed(() =>
        repos.value.reduce((total, repo) => total + repo.conflicted.length + repo.staged.length + repo.unstaged.length + (repo.truncated ?? 0), 0),
    );
    // How much a plain Commit would record, across every repo, what the commit box reads out, and what decides
    // whether the button is "Commit" or "Commit all". Ahead/behind stay off this summary: sync is a per-repo act
    // (each has its own remote and branch), so the panel reads `repo.remote` straight off the row, for the row
    // pills and for the primary button's aggregate alike, which hands syncAll the resolved per-repo targets.
    const stagedCount = computed(() => repos.value.reduce((total, repo) => total + repo.staged.length, 0));
    // What a clean tree still owes its remotes, the other half of "is there anything to do here", which the
    // count above deliberately says nothing about. See outgoingWork.ts for why it is outgoing-only.
    const outgoing = computed(() => outgoingWork(repos.value));
    /* Which repos have a commit RUNNING, this tab's, and anyone's. The union is the whole point: the local half
     * answers on the click, the daemon's half answers after a reload and for a second tab, and a repo in either
     * is one whose rows are being recorded right now. Rows the daemon reports as committing are still LISTED,
     * they are genuinely still uncommitted until the commit returns, so the panel dims them and takes their
     * verbs away rather than guessing them gone. */
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
