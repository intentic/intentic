import type { SnapshotChange, SnapshotFileDiffResponse } from "@intentic-app/api-contract";
import { useQuery } from "@tanstack/vue-query";
import { computed, ref, watch } from "vue";
import { queryClient } from "../queryPersistence";
import { sandboxJson } from "../sandboxClient";
import { useChat } from "../chat/useChat";
import { useHistory } from "./useHistory";
import { useSandbox } from "../useSandbox";

/* The Changes review: "what has the agent changed since I last verified?". A per-sandbox baseline snapshot is the
 * watermark of the last accept/discard; the review set is the aggregate diff of the current head snapshot against
 * that baseline (history.diff with `base`). Inspect a file (opens a diff tab), Discard all (restore to baseline),
 * or Approve (git-commit any touched repos, then mark reviewed). Both actions advance the baseline, clearing the
 * set — the "mark reviewed" mechanic. Module-level singletons so the badge (shell), the panel, and the workspace
 * agree. */

// baseline is keyed per sandbox so switching sandboxes never carries a watermark across.
const baselineKey = (sandboxId: string): string => `ui-workspace-review-baseline:${sandboxId}`;

const readBaseline = (sandboxId: string | undefined): string | undefined => {
    if (sandboxId === undefined) {
        return undefined;
    }
    try {
        return localStorage.getItem(baselineKey(sandboxId)) ?? undefined;
    } catch {
        return undefined;
    }
};

const { activeSandboxId, reachable } = useSandbox();

const baseline = ref<string | undefined>(readBaseline(activeSandboxId.value));
// Reload the watermark whenever the active sandbox changes (each has its own).
watch(activeSandboxId, (id) => (baseline.value = readBaseline(id)));

// An agent turn ends when chat streaming falls, and the daemon has just taken its "turn" snapshot — refresh the
// snapshot list so the badge/panel surface it without a manual refresh. Module scope (like sandboxScope.ts), NOT
// inside useReview(): a watch installed from a component dies with that component's effect scope, and the /setup
// round-trip unmounts the shell that calls useReview() first. Prefix match: the real key is
// ["history","snapshots",<sandboxId ref>] (sandboxKey appends the id).
const { streaming } = useChat();
watch(streaming, (now, was) => {
    if (was && !now) {
        void queryClient.invalidateQueries({ queryKey: [`history`, `snapshots`] });
    }
});

const setBaseline = (value: string): void => {
    baseline.value = value;
    const sandboxId = activeSandboxId.value;
    if (sandboxId === undefined) {
        return;
    }
    try {
        localStorage.setItem(baselineKey(sandboxId), value);
    } catch {
        // Storage may be unavailable (private mode); the in-memory ref still holds for this session.
    }
};

// The daemon's /git/{repo}/commit only accepts the three workspace repos; a "root"-scope change is shown but not
// committed (the agent works inside the repos, so root changes are rare).
const COMMITTABLE_REPOS = new Set([`intent`, `desired-state`, `app`]);
const repoOfScope = (scope: string): string | undefined =>
    scope.startsWith(`repositories/`) ? scope.slice(`repositories/`.length) : undefined;

const actionBusy = ref(false);
const actionError = ref<string | undefined>(undefined);

export function useReview() {
    const { snapshots, diff, fileDiff, restore, refetch: refetchSnapshots } = useHistory();

    // Newest snapshot (history groups are sorted newest-first).
    const headId = computed(() => snapshots.value[0]?.id);

    // The baseline is a localStorage watermark keyed by the platform sandbox id, but the sandbox's /history volume
    // is wiped on a container rebuild — so a stored baseline can outlive the snapshot it names. Only trust it while
    // it still exists in the current history.
    const baselineValid = computed(() => baseline.value !== undefined && snapshots.value.some((snapshot) => snapshot.id === baseline.value));

    // Adopt-or-heal: on first use (no baseline) adopt the current head so only NEW agent changes surface; if a
    // stored baseline is stale (rebuilt/trimmed history, or another session), re-adopt the head instead of diffing
    // against a snapshot the daemon no longer has (which 404s the whole panel). headId always comes from
    // snapshots[0], so re-adopting is always valid; while snapshots are empty, headId is undefined and this no-ops.
    watch(
        [headId, snapshots],
        () => {
            if (headId.value !== undefined && activeSandboxId.value !== undefined && !baselineValid.value) {
                setBaseline(headId.value);
            }
        },
        { immediate: true },
    );

    const active = computed(() => headId.value !== undefined && baselineValid.value && headId.value !== baseline.value);

    const changesQuery = useQuery({
        queryKey: computed(() => [`review`, `changes`, activeSandboxId.value, baseline.value, headId.value]),
        queryFn: () => diff(headId.value ?? ``, baseline.value).then((response) => response.changes),
        enabled: computed(() => active.value && reachable.value),
    });

    const changes = computed<readonly SnapshotChange[]>(() => (active.value ? (changesQuery.data.value ?? []) : []));
    const count = computed(() => changes.value.length);
    const hasUnreviewed = computed(() => count.value > 0);
    const error = computed(() => (changesQuery.error.value ? changesQuery.error.value.message : undefined));

    const reviewFileDiff = (scope: string, path: string): Promise<SnapshotFileDiffResponse> =>
        fileDiff(headId.value ?? ``, scope, path, baseline.value);

    // The repos a Commit would touch (deduped, committable only).
    const committableRepos = computed(() => [
        ...new Set(changes.value.map((change) => repoOfScope(change.scope)).filter((repo): repo is string => repo !== undefined && COMMITTABLE_REPOS.has(repo))),
    ]);

    const advanceBaseline = (): void => {
        if (headId.value !== undefined) {
            setBaseline(headId.value);
        }
    };

    // Discard: rewrite /work back to the baseline. restore() takes its own safety snapshot and refreshes the tree +
    // snapshots, so afterwards head has moved on — re-point the baseline at it to clear the set.
    const discardAll = async (): Promise<void> => {
        if (baseline.value === undefined) {
            return;
        }
        actionError.value = undefined;
        actionBusy.value = true;
        try {
            await restore(baseline.value);
            advanceBaseline();
        } catch (caught) {
            actionError.value = caught instanceof Error ? caught.message : `Discard failed.`;
        } finally {
            actionBusy.value = false;
        }
    };

    // Approve: mark the set reviewed (advance the baseline) — always possible. Touched git repos are also
    // committed (the daemon commits the whole repo working tree); root-scope changes have no repo to commit to,
    // so a root-only set approves without any git call. The commit doesn't move the shadow-history head, so
    // advancing the baseline is what clears the review either way.
    const approve = async (message: string): Promise<void> => {
        const repos = committableRepos.value;
        if (repos.length === 0) {
            advanceBaseline();
            return;
        }
        actionError.value = undefined;
        actionBusy.value = true;
        try {
            for (const repo of repos) {
                await sandboxJson(`/git/${encodeURIComponent(repo)}/commit`, {
                    method: `POST`,
                    headers: { "content-type": `application/json` },
                    body: JSON.stringify({ message }),
                });
            }
            advanceBaseline();
        } catch (caught) {
            actionError.value = caught instanceof Error ? caught.message : `Approve failed.`;
        } finally {
            actionBusy.value = false;
        }
    };

    const refresh = async (): Promise<void> => {
        await refetchSnapshots();
        await changesQuery.refetch();
    };

    return {
        headId,
        changes,
        count,
        hasUnreviewed,
        loading: changesQuery.isFetching,
        error,
        committableRepos,
        reviewFileDiff,
        discardAll,
        approve,
        refresh,
        actionBusy,
        actionError,
    };
}
