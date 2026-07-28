import type { FileDiffResponse, GitActionResult, GitChangesResponse, GitDiffSide, OriginAgent, RepoChanges } from "@intentic-app/api-contract";
import { computed, ref, watch } from "vue";
import { useChat } from "../chat/useChat";
import { queryClient } from "../queryPersistence";
import { sandboxJson } from "../sandbox/sandboxClient";
import { sandboxKey } from "../sandbox/useSandbox";
import { useSandboxQuery } from "../sandbox/useSandboxQuery";
import { errorMessage } from "../useAsyncAction";
import { resetEditBuffers } from "./useEditBuffers";

/* The Changes review — VSCode's SCM model over the workspace's real repos, including git's index: each repo
 * reports `staged` (index vs HEAD — what a bare commit would record) and `unstaged` (worktree vs index, plus
 * untracked), because a path can sit on both with different content. "root" (the /work repo itself) plus every
 * discovered repo under it, aggregated by the daemon's /git/changes.
 *
 * VSCode's model all the way down, which means STAGING IS THE SELECTION: `commitRepos` records the index and
 * nothing else, and the only way to shape a commit is to stage. There is no path-scoped commit here (or in the
 * daemon) because git already has one mechanism for choosing a commit's contents and a second one could only
 * contradict it. Discard restores the worktree from HEAD; the remote verbs sync it.
 *
 * No client-side watermark: the reviewed line IS the commit boundary, so every browser and device agrees.
 * Module-level singletons so the badge (shell), the panel, and the workspace agree. */

// A turn ending is when its work becomes reviewable — refresh the review set and the snapshot timeline so the
// badge and panels surface it without a manual refresh. Counted across ALL conversations, not the active tab's
// stream: a background tab's turn lands into the same tree, and watching only the focused one meant the panel
// went stale for exactly the turns the user wasn't watching. Module scope (like sandboxScope.ts), NOT inside
// useChanges(): a watch installed from a component dies with that component's effect scope, and the /setup
// round-trip unmounts the shell that calls useChanges() first. Prefix match: the real keys are
// ["git","changes",<sandboxId ref>] / ["history","snapshots",<id>] (sandboxKey appends the id).
const { conversations } = useChat();
const turnsRunning = computed(() => conversations.value.filter((conversation) => conversation.streaming.value).length);
watch(turnsRunning, (now, was) => {
    if (now < was) {
        void queryClient.invalidateQueries({ queryKey: [`git`, `changes`] });
        void queryClient.invalidateQueries({ queryKey: [`history`, `snapshots`] });
    }
});

/* --- action state -------------------------------------------------------------------------------------------
 * Every mutation below reports through `runBatch`: one busy span for the whole batch, and any failure filed
 * under the SCOPE the user fired it from — a repo id for the per-repo verbs, COMMIT_SCOPE for the commit box
 * that spans them. Scoped, not panel-wide: a fetch that failed on `intentic` has nothing to say about `root`,
 * and the single shared error line this replaces rendered at the top of the panel naming neither the repo nor
 * the verb, so a failed fetch read as a stray red sentence with no visible cause.
 *
 * The verb is kept apart from git's words for the same reason. "Fetch failed" is what the user needs to read
 * first; `fatal: could not read Username for 'https://github.com'` is the detail underneath it. */
export interface ActionFailure {
    // The verb that failed, in the user's terms — "Fetch failed", "Discard failed".
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

const dismissFailure = (scope: string): void => {
    if (!failures.value.has(scope)) {
        return;
    }
    const next = new Map(failures.value);
    next.delete(scope);
    failures.value = next;
};

// One busy span over a batch of per-scope tasks. A failure is filed against its own scope and the batch CARRIES
// ON: the repos are independent, so aborting root's discard because intentic's remote is unreachable would
// strand work the user asked for behind a failure they cannot act on. Re-entry while busy is a no-op, so a
// double-click fires once. `settle` runs whatever happened — the cache must match the worktree even when only
// half the batch landed.
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
        for (const task of tasks) {
            try {
                await task.run();
            } catch (caught) {
                failures.value = new Map(failures.value).set(task.scope, {
                    action: task.action,
                    detail: errorMessage(caught, `git gave no reason.`),
                });
            }
        }
        await settle();
    } finally {
        actionBusy.value = false;
    }
};

// The diff of the ROW that was clicked, not of the file in general: `staged` is index-vs-HEAD, `unstaged` is
// worktree-vs-index. A partially staged file has both, and they differ — showing one for the other would be a
// quiet lie, so the side is required rather than defaulted.
const fileDiff = (repo: string, path: string, side: GitDiffSide): Promise<FileDiffResponse> =>
    sandboxJson<FileDiffResponse>(`/git/${encodeURIComponent(repo)}/file-diff?path=${encodeURIComponent(path)}&side=${side}`);

// One repo's slice of a batch action: an explicit `paths` subset, or the whole repo when `paths` is absent.
export interface RepoPaths {
    readonly repo: string;
    readonly paths?: readonly string[];
}

const invalidateChanges = (): Promise<void> => queryClient.invalidateQueries({ queryKey: sandboxKey(`git`, `changes`) });

const post = <T>(repo: string, action: string, body: Record<string, unknown>): Promise<T> =>
    sandboxJson<T>(`/git/${encodeURIComponent(repo)}/${action}`, {
        method: `POST`,
        headers: { "content-type": `application/json` },
        body: JSON.stringify(body),
    });

// Commit what is staged. git can't span repos, so each named repo gets its own real commit on its own branch,
// all sharing the message — one refresh for the whole batch. `stageFirst` is VSCode's "stage all and commit"
// for the case where nothing is staged yet; it maps onto the daemon's `all` shape (`git commit -a`).
//
// There is no per-path variant, deliberately: the index is what decides a commit's contents, so the panel's
// job is to make staging easy, not to maintain a second answer to the same question.
const commitRepos = (repos: readonly string[], message: string, stageFirst: boolean): Promise<void> =>
    runBatch(
        repos.map((repo) => ({
            scope: COMMIT_SCOPE,
            action: `Commit failed`,
            run: async (): Promise<void> => {
                await post(repo, `commit`, { message, ...(stageFirst ? { all: true } : {}) });
            },
        })),
        invalidateChanges,
    );

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
            // Stale buffers would silently resurrect discarded files on save. RAW prefix for the tree — its keys
            // carry an "all"/"filtered" discriminator before the appended sandbox id, so sandboxKey("workspace",
            // "tree") would NOT prefix-match them (see useSandbox).
            resetEditBuffers();
            return Promise.all([queryClient.invalidateQueries({ queryKey: [`workspace`, `tree`] }), invalidateChanges()]);
        },
    );

// Index moves. The worktree is untouched, so unlike discard there is nothing to reset or re-read beyond the
// review set itself — no buffer drop, no tree refetch.
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
    await queryClient.invalidateQueries({ queryKey: [`workspace`, `tree`] });
};

// Remote sync, per repo. Each reports a GitActionResult rather than throwing, so "won't fast-forward" or a
// credential failure surfaces as git's own reason on the action line instead of a generic request error.
const syncRepo = (repo: string, action: "fetch" | "pull" | "push", label: string): Promise<void> =>
    runBatch(
        [
            {
                scope: repo,
                action: `${label} failed`,
                run: async (): Promise<void> => {
                    const result = await post<GitActionResult>(repo, action, {});
                    if (!result.ok) {
                        // git's own reason, which the daemon already condensed to its verdict line. Empty falls
                        // through to runBatch's fallback rather than being papered over with the verb again.
                        throw new Error(result.reason);
                    }
                    if (action === `pull`) {
                        await afterPull();
                    }
                },
            },
        ],
        () => Promise.all([invalidateChanges(), queryClient.invalidateQueries({ queryKey: [`git`, `log`] })]),
    );

// The aggregate the panel's primary button fires once the commit box has nothing left to show: the commits you
// just made are one labelled click from their remote — in the very place you committed them — instead of a muted
// ↑N pill you had to know to hunt for on a repo row. git can't span remotes, so, exactly like commitRepos, this
// is one real sync PER repo under a single busy span, each failure filed against its own repo row. Per repo the
// order is pull-then-push: fast-forward the branch up to its upstream before sending local commits, so a push
// can't be rejected for work we could have taken first. `pull`/`push` come straight off the row's ahead/behind,
// so a repo that needs only one gets only one, and a set whose repos disagree still resolves each on its own.
export interface SyncTarget {
    readonly repo: string;
    readonly pull: boolean; // behind its upstream — fast-forward it first
    readonly push: boolean; // ahead, or a branch with no upstream yet — send (publishing it when unpublished) after
}
const syncAll = (targets: readonly SyncTarget[]): Promise<void> =>
    runBatch(
        targets.map((target) => ({
            scope: target.repo,
            // Name the verb the repo actually needed, so a push-only repo that fails reads "Push failed" — not a
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
        () => Promise.all([invalidateChanges(), queryClient.invalidateQueries({ queryKey: [`git`, `log`] })]),
    );

export function useChanges() {
    const { query, error } = useSandboxQuery({
        queryKey: sandboxKey(`git`, `changes`),
        queryFn: () => sandboxJson<GitChangesResponse>(`/git/changes`),
    });

    // `repos` also carries the repos git could NOT scan (empty change lists + a one-line `error`; the panel
    // renders them as their own rows) and repos that are merely out of sync with their remote (clean tree,
    // non-zero ahead/behind). They contribute 0 to `count`, which is what every badge wants — a torn or merely
    // unpushed repo has no reviewable work — and the panel, the only consumer that iterates the list, splits
    // them out itself.
    const repos = computed<readonly RepoChanges[]>(() => query.data.value?.repos ?? []);
    // Who the agent ids in `repo.origins` are, straight off the response. The panel does NOT resolve them
    // against the fleet roster alone: that roster is the live board and drops archived agents, while a landing
    // outlives the card — see OriginAgentSchema in the contract for why the identity rides the review instead.
    const originAgents = computed<Readonly<Record<string, OriginAgent>>>(() => query.data.value?.originAgents ?? {});
    const count = computed(() => repos.value.reduce((total, repo) => total + repo.staged.length + repo.unstaged.length, 0));
    const hasChanges = computed(() => count.value > 0);
    // How much a plain Commit would record, across every repo — what the commit box reads out, and what decides
    // whether the button is "Commit" or "Commit all". Ahead/behind stay off this summary: sync is a per-repo act
    // (each has its own remote and branch), so the panel reads `repo.remote` straight off the row — for the row
    // pills and for the primary button's aggregate alike, which hands syncAll the resolved per-repo targets.
    const stagedCount = computed(() => repos.value.reduce((total, repo) => total + repo.staged.length, 0));

    return {
        repos,
        originAgents,
        count,
        stagedCount,
        hasChanges,
        loading: query.isFetching,
        error,
        refresh: query.refetch,
        fileDiff,
        commitRepos,
        discardGroups,
        stageGroups,
        fetchRepo: (repo: string) => syncRepo(repo, `fetch`, `Fetch`),
        pullRepo: (repo: string) => syncRepo(repo, `pull`, `Pull`),
        pushRepo: (repo: string) => syncRepo(repo, `push`, `Push`),
        syncAll,
        actionBusy,
        // Keyed by repo id (the per-repo verbs) or COMMIT_SCOPE — the panel renders each one where it happened.
        failures,
        dismissFailure,
    };
}
