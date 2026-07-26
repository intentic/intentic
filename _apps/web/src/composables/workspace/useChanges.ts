import type { FileDiffResponse, GitActionResult, GitChangesResponse, GitDiffSide, RepoChanges } from "@intentic-app/api-contract";
import { computed, watch } from "vue";
import { useChat } from "../chat/useChat";
import { queryClient } from "../queryPersistence";
import { sandboxJson } from "../sandbox/sandboxClient";
import { sandboxKey } from "../sandbox/useSandbox";
import { useSandboxQuery } from "../sandbox/useSandboxQuery";
import { useAsyncAction } from "../useAsyncAction";
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

// An agent turn ends when chat streaming falls — refresh the review set and the snapshot timeline so the badge
// and panels surface the turn's work without a manual refresh. Module scope (like sandboxScope.ts), NOT inside
// useChanges(): a watch installed from a component dies with that component's effect scope, and the /setup
// round-trip unmounts the shell that calls useChanges() first. Prefix match: the real keys are
// ["git","changes",<sandboxId ref>] / ["history","snapshots",<id>] (sandboxKey appends the id).
const { streaming } = useChat();
watch(streaming, (now, was) => {
    if (was && !now) {
        void queryClient.invalidateQueries({ queryKey: [`git`, `changes`] });
        void queryClient.invalidateQueries({ queryKey: [`history`, `snapshots`] });
    }
});

// Batch mutations report through one shared busy span + error line, so N per-repo requests read as one action.
const { busy: actionBusy, error: actionError, run } = useAsyncAction();

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
    run(async () => {
        for (const repo of repos) {
            await post(repo, `commit`, { message, ...(stageFirst ? { all: true } : {}) });
        }
        await invalidateChanges();
    }, `Commit failed.`);

// Discard a selection: tracked content returns to HEAD, untracked files are deleted. A group with no `paths`
// discards the whole repo. Drop edit buffers + refresh the tree (the worktree changed under any open file).
const discardGroups = (groups: readonly RepoPaths[]): Promise<void> =>
    run(async () => {
        for (const group of groups) {
            await post(group.repo, `discard`, group.paths !== undefined ? { paths: group.paths } : {});
        }
        // Stale buffers would silently resurrect discarded files on save. RAW prefix for the tree — its keys
        // carry an "all"/"filtered" discriminator before the appended sandbox id, so sandboxKey("workspace",
        // "tree") would NOT prefix-match them (see useSandbox).
        resetEditBuffers();
        await Promise.all([queryClient.invalidateQueries({ queryKey: [`workspace`, `tree`] }), invalidateChanges()]);
    }, `Discard failed.`);

// Index moves. The worktree is untouched, so unlike discard there is nothing to reset or re-read beyond the
// review set itself — no buffer drop, no tree refetch.
const stageGroups = (groups: readonly RepoPaths[], staged: boolean): Promise<void> =>
    run(
        async () => {
            for (const group of groups) {
                if (group.paths !== undefined && group.paths.length > 0) {
                    await post(group.repo, staged ? `stage` : `unstage`, { paths: group.paths });
                }
            }
            await invalidateChanges();
        },
        staged ? `Stage failed.` : `Unstage failed.`,
    );

// Remote sync, per repo. Each reports a GitActionResult rather than throwing, so "won't fast-forward" or a
// credential failure surfaces as git's own reason on the action line instead of a generic request error.
const syncRepo = (repo: string, action: "fetch" | "pull" | "push", label: string): Promise<void> =>
    run(async () => {
        const result = await post<GitActionResult>(repo, action, {});
        if (!result.ok) {
            throw new Error(result.reason ?? `${label} failed.`);
        }
        // Pull is the only one that can change files under an open editor.
        if (action === `pull`) {
            resetEditBuffers();
            await queryClient.invalidateQueries({ queryKey: [`workspace`, `tree`] });
        }
        await Promise.all([invalidateChanges(), queryClient.invalidateQueries({ queryKey: [`git`, `log`] })]);
    }, `${label} failed.`);

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
    const count = computed(() => repos.value.reduce((total, repo) => total + repo.staged.length + repo.unstaged.length, 0));
    const hasChanges = computed(() => count.value > 0);
    // How much a plain Commit would record, across every repo — what the commit box reads out, and what decides
    // whether the button is "Commit" or "Commit all". Ahead/behind are deliberately NOT aggregated here: sync is
    // a per-repo act (each has its own remote and branch), so the panel reads `repo.remote` on the row itself.
    const stagedCount = computed(() => repos.value.reduce((total, repo) => total + repo.staged.length, 0));

    return {
        repos,
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
        actionBusy,
        actionError,
    };
}
