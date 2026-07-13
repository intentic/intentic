<script setup lang="ts">
import type { SnapshotChange, SnapshotTrigger, WorkspaceSnapshot } from "@intentic-app/api-contract";
import { ref } from "vue";
import { useHistory } from "../../composables/workspace/useHistory";
import { type IconName, timeAgo } from "@intentic-app/ui";
import { type DiffTabPayload, STATUS_CLASS, STATUS_LETTER } from "./workspaceTabs";

/* The checkpoint timeline — a mode of the workspace's ONE left sidebar (Workspace.vue owns the aside, the
 * resize handle, and the Files|Changes|Checkpoints mode switch): the daemon's checkpoints of /work, NOT git
 * history — agent turns (titled with the turn's prompt), user changes, and restore markers; hidden interval
 * captures dissolve into the next checkpoint's diff. Selecting a checkpoint lazy-loads everything it changed
 * since the previous one; a changed file opens a side-by-side diff as a tab in the main editor area (emitted up
 * to Workspace.vue); Restore (two-step confirm) rewrites /work to that point — files created since are removed,
 * secrets and git branches untouched, and a safety checkpoint is saved first, so a restore is itself
 * restorable. */

const { snapshots, error, isLoading, refetch, diff, fileDiff, restore, busy, actionError } = useHistory();
const emit = defineEmits<{ "open-diff": [payload: DiffTabPayload] }>();

const selectedId = ref<string | undefined>(undefined);
const changes = ref<readonly SnapshotChange[]>([]);
const diffLoading = ref(false);
const confirmRestoreId = ref<string | undefined>(undefined);

// Fallback title + icon per trigger; a snapshot's own label (the turn's prompt) wins as the row title.
// "interval" never surfaces in the list — the daemon keeps those captures off the timeline.
const TRIGGER_META: Record<SnapshotTrigger, { title: string; icon: IconName }> = {
    turn: { title: `Agent turn`, icon: `sparkles` },
    user: { title: `Your changes`, icon: `user` },
    "pre-restore": { title: `Before restore`, icon: `shield` },
    restore: { title: `Restore point`, icon: `undo` },
    interval: { title: `Auto capture`, icon: `clock` },
};

const changeLabel = (change: SnapshotChange): string => (change.scope === `root` ? change.path : `${change.scope}/${change.path}`);

const select = (snapshot: WorkspaceSnapshot): void => {
    confirmRestoreId.value = undefined;
    if (selectedId.value === snapshot.id) {
        selectedId.value = undefined;
        return;
    }
    selectedId.value = snapshot.id;
    changes.value = [];
    diffLoading.value = true;
    void diff(snapshot.id)
        .then((body) => {
            if (selectedId.value === snapshot.id) {
                changes.value = body.changes;
            }
        })
        .finally(() => (diffLoading.value = false));
};

const openDiff = (change: SnapshotChange): void => {
    const snapshotId = selectedId.value;
    if (snapshotId === undefined) {
        return;
    }
    void fileDiff(snapshotId, change.scope, change.path).then((body) => {
        emit(`open-diff`, { key: snapshotId, scope: change.scope, label: changeLabel(change), status: change.status, path: change.path, ...body });
    });
};

const confirmRestore = (id: string): void => {
    confirmRestoreId.value = undefined;
    void restore(id);
};
</script>

<template>
    <div class="flex min-h-0 flex-1 flex-col">
        <div class="flex shrink-0 items-center gap-1 border-b border-line px-2 py-1.5">
            <span class="text-2xs font-medium uppercase tracking-wide text-subtle">Checkpoints</span>
            <span class="flex-1"></span>
            <Icon name="spinner" v-if="busy" v-tooltip.top="'Working…'" class="text-xs text-muted" spin />
            <button
                type="button"
                class="flex h-6 w-6 items-center justify-center rounded-md text-muted transition-colors hover:bg-overlay hover:text-content"
                @click="refetch()"
                v-tooltip.top="'Refresh'"
                aria-label="Refresh checkpoints"
            >
                <Icon name="refresh" class="text-xs" :spin="isLoading" />
            </button>
        </div>

        <p v-if="error" class="shrink-0 truncate px-2 py-1 text-2xs text-danger" v-tooltip.bottom="error">{{ error }}</p>
        <p v-if="actionError" class="shrink-0 truncate px-2 py-1 text-2xs text-danger" v-tooltip.bottom="actionError">{{ actionError }}</p>

        <div class="scrollbar-thin min-h-0 flex-1 overflow-auto py-1">
            <p v-if="snapshots.length === 0" class="px-3 py-2 text-2xs text-subtle">
                No checkpoints yet — one is saved after each agent turn and whenever you change files.
            </p>
            <div v-for="snapshot in snapshots" :key="snapshot.id" class="cv-row border-b border-line/50">
                <button
                    type="button"
                    class="flex w-full items-center gap-2 px-2 py-1.5 text-left transition-colors hover:bg-overlay max-md:min-h-11"
                    @click="select(snapshot)"
                >
                    <Icon class="text-2xs text-subtle" :name="selectedId === snapshot.id ? 'chevron-down' : 'chevron-right'" />
                    <Icon class="shrink-0 text-2xs text-muted" :name="TRIGGER_META[snapshot.trigger].icon" />
                    <span class="min-w-0 flex-1 truncate text-xs text-content" :title="snapshot.label">{{
                        snapshot.label ?? TRIGGER_META[snapshot.trigger].title
                    }}</span>
                    <span class="shrink-0 text-2xs text-muted">{{ timeAgo(snapshot.at) }}</span>
                </button>

                <div v-if="selectedId === snapshot.id" class="pb-1.5 pl-4 pr-2">
                    <p v-if="diffLoading" class="py-1 text-2xs text-subtle">Loading changes…</p>
                    <p v-else-if="changes.length === 0" class="py-1 text-2xs text-subtle">No file changes recorded.</p>
                    <button
                        v-for="change in changes"
                        :key="`${change.scope}/${change.path}`"
                        type="button"
                        class="cv-file flex w-full items-center gap-1.5 rounded px-1 py-0.5 text-left transition-colors hover:bg-overlay max-md:min-h-11"
                        @click="openDiff(change)"
                        :title="changeLabel(change)"
                    >
                        <span class="w-3 shrink-0 text-center font-mono text-2xs" :class="STATUS_CLASS[change.status]">{{
                            STATUS_LETTER[change.status]
                        }}</span>
                        <span class="truncate text-2xs text-muted max-md:text-xs" dir="rtl">{{ changeLabel(change) }}</span>
                    </button>

                    <div class="mt-1.5 flex items-center gap-2">
                        <template v-if="confirmRestoreId === snapshot.id">
                            <span class="flex-1 text-2xs text-warning"
                                >Rewrite all files to this checkpoint? Files created after it are removed; git branches and secrets are
                                untouched.</span
                            >
                            <button
                                type="button"
                                class="rounded border border-danger/50 px-2 py-0.5 text-2xs text-danger transition-colors hover:bg-danger/10"
                                @click="confirmRestore(snapshot.id)"
                            >
                                Restore
                            </button>
                            <button type="button" class="text-2xs text-muted hover:text-content" @click="confirmRestoreId = undefined">Cancel</button>
                        </template>
                        <button
                            v-else
                            type="button"
                            class="rounded border border-line px-2 py-0.5 text-2xs text-muted transition-colors hover:bg-overlay hover:text-content max-md:min-h-11 max-md:px-3 max-md:text-xs"
                            :disabled="busy"
                            @click="confirmRestoreId = snapshot.id"
                            v-tooltip.bottom="
                                'Bring the workspace back to this checkpoint. Secrets and git branches are untouched; a safety checkpoint is saved first.'
                            "
                        >
                            <Icon name="history" class="mr-1 text-2xs" />Restore
                        </button>
                    </div>
                </div>
            </div>
        </div>
    </div>
</template>

<style scoped>
/* Cheap windowing without a virtual-scroller: the browser skips layout/paint for off-screen rows on long
 * snapshot and changed-file lists. contain-intrinsic-size reserves a plausible height so the scrollbar is
 * stable before a row is first rendered. */
.cv-row {
    content-visibility: auto;
    contain-intrinsic-size: auto 34px;
}
.cv-file {
    content-visibility: auto;
    contain-intrinsic-size: auto 22px;
}
</style>
