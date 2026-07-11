<script setup lang="ts">
import type { SnapshotChange } from "@intentic-app/api-contract";
import { computed, ref } from "vue";
import { useReview } from "../../composables/workspace/useReview";
import { type DiffTabPayload, STATUS_CLASS, STATUS_LETTER } from "./workspaceTabs";

/* The Changes review — a mode of the workspace's ONE left sidebar (Workspace.vue owns the aside, the resize
 * handle, and the Files|Changes|History mode switch): what the agent changed since the last time you verified
 * (the aggregate diff of the current workspace against the per-sandbox baseline snapshot). Files are grouped by
 * repo; clicking one opens a side-by-side diff as a tab in the main editor area. Discard all rewrites /work back
 * to the baseline; Approve git-commits any touched repos and marks the set reviewed. Both actions clear the set
 * (they advance the baseline). */

const review = useReview();
const emit = defineEmits<{ "open-diff": [payload: DiffTabPayload] }>();

// Group the flat change list by scope; the three workspace repos read nicer without the "repositories/" prefix.
const repoLabel = (scope: string): string => (scope === `root` ? `root` : scope.slice(`repositories/`.length));
const groups = computed(() => {
    const byScope = new Map<string, SnapshotChange[]>();
    for (const change of review.changes.value) {
        const list = byScope.get(change.scope);
        if (list === undefined) {
            byScope.set(change.scope, [change]);
        } else {
            list.push(change);
        }
    }
    return [...byScope.entries()]
        .map(([scope, changes]) => ({ scope, label: repoLabel(scope), changes }))
        .toSorted((a, b) => a.label.localeCompare(b.label));
});

const collapsed = ref<ReadonlySet<string>>(new Set());
const toggleGroup = (scope: string): void => {
    const next = new Set(collapsed.value);
    if (!next.delete(scope)) {
        next.add(scope);
    }
    collapsed.value = next;
};

const changeLabel = (change: SnapshotChange): string => (change.scope === `root` ? change.path : `${repoLabel(change.scope)}/${change.path}`);

const openDiff = (change: SnapshotChange): void => {
    const snapshotId = review.headId.value;
    if (snapshotId === undefined) {
        return;
    }
    void review.reviewFileDiff(change.scope, change.path).then((body) => {
        emit(`open-diff`, { snapshotId, scope: change.scope, label: changeLabel(change), status: change.status, path: change.path, ...body });
    });
};

// Two-step Discard + the Approve flow, mirroring the History panel's confirm-in-place pattern. Approving a set
// that touches git repos opens the commit-message composer first; a root-only set has nothing to commit and
// approves immediately — approval must never dead-end on committability.
const confirmingDiscard = ref(false);
const composingApprove = ref(false);
const commitMessage = ref(`Verified agent changes`);

const discard = (): void => {
    confirmingDiscard.value = false;
    void review.discardAll();
};
const approve = (): void => {
    composingApprove.value = false;
    void review.approve(commitMessage.value);
};
const startApprove = (): void => {
    confirmingDiscard.value = false;
    if (review.committableRepos.value.length === 0) {
        approve();
        return;
    }
    composingApprove.value = true;
};
</script>

<template>
    <div class="flex min-h-0 flex-1 flex-col">
        <div class="flex shrink-0 items-center gap-1 border-b border-line px-2 py-1.5">
            <span class="text-2xs font-medium uppercase tracking-wide text-subtle">Unreviewed changes</span>
            <span class="flex-1"></span>
            <Icon name="spinner" v-if="review.actionBusy.value" v-tooltip.top="'Working…'" class="text-xs text-muted" spin />
            <button
                type="button"
                class="flex h-6 w-6 items-center justify-center rounded-md text-muted transition-colors hover:bg-overlay hover:text-content"
                @click="review.refresh()"
                v-tooltip.top="'Refresh'"
                aria-label="Refresh changes"
            >
                <Icon name="refresh" class="text-xs" :spin="review.loading.value" />
            </button>
        </div>

        <p v-if="review.error.value" class="shrink-0 truncate px-2 py-1 text-2xs text-danger" v-tooltip.bottom="review.error.value">
            {{ review.error.value }}
        </p>
        <p v-if="review.actionError.value" class="shrink-0 truncate px-2 py-1 text-2xs text-danger" v-tooltip.bottom="review.actionError.value">
            {{ review.actionError.value }}
        </p>

        <div class="scrollbar-thin min-h-0 flex-1 overflow-auto py-1">
            <p v-if="review.loading.value && review.count.value === 0" class="px-3 py-2 text-2xs text-subtle">Loading changes…</p>
            <p v-else-if="review.count.value === 0" class="px-3 py-2 text-2xs text-subtle">
                No unreviewed agent changes. When the agent edits files, they show up here to inspect, discard, or commit.
            </p>
            <div v-for="group in groups" :key="group.scope" class="border-b border-line/50">
                <button
                    type="button"
                    class="flex w-full items-center gap-2 px-2 py-1.5 text-left transition-colors hover:bg-overlay max-md:min-h-11"
                    @click="toggleGroup(group.scope)"
                >
                    <Icon class="text-2xs text-subtle" :name="collapsed.has(group.scope) ? 'chevron-right' : 'chevron-down'" />
                    <span class="text-xs font-medium text-content">{{ group.label }}</span>
                    <span class="rounded-full bg-overlay px-1.5 py-px text-2xs text-muted">{{ group.changes.length }}</span>
                </button>
                <div v-if="!collapsed.has(group.scope)" class="pb-1 pl-4 pr-2">
                    <button
                        v-for="change in group.changes"
                        :key="`${change.scope}/${change.path}`"
                        type="button"
                        class="flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left transition-colors hover:bg-overlay max-md:min-h-11"
                        @click="openDiff(change)"
                        :title="changeLabel(change)"
                    >
                        <span class="w-3 shrink-0 text-center font-mono text-2xs" :class="STATUS_CLASS[change.status]">{{
                            STATUS_LETTER[change.status]
                        }}</span>
                        <span class="truncate text-2xs text-muted max-md:text-xs" dir="rtl">{{ change.path }}</span>
                    </button>
                </div>
            </div>
        </div>

        <!-- Footer action bar: Discard all (two-step) + Approve (the primary action — always available while
             changes exist; commits touched repos via the message composer, or clears instantly when only
             root-scope files changed). Hidden when there's nothing to review. -->
        <div v-if="review.count.value > 0" class="shrink-0 border-t border-line p-2">
            <div v-if="composingApprove" class="flex flex-col gap-1.5">
                <input
                    v-model="commitMessage"
                    type="text"
                    placeholder="Commit message"
                    class="w-full min-w-0 rounded-md border border-line bg-canvas px-2 py-1 text-xs text-content placeholder:text-subtle focus:border-line-strong focus:outline-none"
                    @keydown.enter="approve"
                    @keydown.esc="composingApprove = false"
                />
                <span class="text-2xs text-subtle">Commits {{ review.committableRepos.value.join(`, `) }} and marks everything reviewed.</span>
                <div class="flex items-center justify-end gap-2">
                    <button type="button" class="text-2xs text-muted hover:text-content" @click="composingApprove = false">Cancel</button>
                    <button
                        type="button"
                        class="inline-flex items-center whitespace-nowrap rounded-md bg-success px-2.5 py-1 text-2xs font-medium text-white transition-colors hover:bg-success/85 disabled:opacity-40"
                        :disabled="review.actionBusy.value || commitMessage.trim().length === 0"
                        @click="approve"
                    >
                        <Icon name="check" class="mr-1 text-2xs" />Approve & commit
                    </button>
                </div>
            </div>
            <div v-else-if="confirmingDiscard" class="flex flex-col gap-1.5">
                <span class="text-2xs text-warning">Discard all agent changes and rewrite the workspace to the baseline?</span>
                <div class="flex items-center justify-end gap-2">
                    <button type="button" class="text-2xs text-muted hover:text-content" @click="confirmingDiscard = false">Cancel</button>
                    <button
                        type="button"
                        class="rounded border border-danger/50 px-2 py-0.5 text-2xs text-danger transition-colors hover:bg-danger/10"
                        :disabled="review.actionBusy.value"
                        @click="discard"
                    >
                        Discard
                    </button>
                </div>
            </div>
            <div v-else class="flex items-center gap-2">
                <button
                    type="button"
                    class="inline-flex items-center whitespace-nowrap rounded border border-line px-2 py-0.5 text-2xs text-muted transition-colors hover:bg-overlay hover:text-content disabled:opacity-40 max-md:min-h-11 max-md:px-3 max-md:text-xs"
                    :disabled="review.actionBusy.value"
                    @click="confirmingDiscard = true"
                    v-tooltip.top="'Roll the workspace back to before these changes. A safety snapshot is taken first.'"
                >
                    <Icon name="undo" class="mr-1 text-2xs" />Discard all
                </button>
                <span class="flex-1"></span>
                <button
                    type="button"
                    class="inline-flex items-center whitespace-nowrap rounded-md bg-success px-2.5 py-1 text-2xs font-medium text-white transition-colors hover:bg-success/85 disabled:opacity-40 max-md:min-h-11 max-md:px-4 max-md:text-xs"
                    :disabled="review.actionBusy.value"
                    @click="startApprove"
                    v-tooltip.top="
                        review.committableRepos.value.length === 0
                            ? 'Mark these changes as reviewed'
                            : 'Commit the touched repos and mark everything reviewed'
                    "
                >
                    <Icon name="check" class="mr-1 text-2xs" />Approve {{ review.count.value }} {{ review.count.value === 1 ? "change" : "changes" }}
                </button>
            </div>
        </div>
    </div>
</template>
