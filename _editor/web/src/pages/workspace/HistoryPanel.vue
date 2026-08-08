<script setup lang="ts">
import type { SnapshotChange, SnapshotTrigger, WorkspaceSnapshot } from "@intentic-app/api-contract";
import { ref } from "vue";
import { diffRawUrls } from "../../composables/workspace/diffRaw";
import { useHistory } from "../../composables/workspace/useHistory";
import { ChangeStatusMark, cmp, type IconName, timeAgo } from "@intentic/ui";
import type { DiffPayload } from "@intentic/extension-api";
import type { OpenMode } from "./workspaceTabs";

/* The restore-point timeline — a quieter mode of the workspace's ONE left sidebar (Workspace.vue owns the
 * aside, resize handle, Files|Changes switch and history button): the daemon's checkpoints of /work, NOT git
 * history — agent turns (titled with the turn's prompt), user changes, and restore markers; hidden interval
 * captures dissolve into the next checkpoint's diff. Selecting a checkpoint lazy-loads everything it changed
 * since the previous one; a changed file opens a side-by-side diff as a tab in the main editor area (emitted up
 * to Workspace.vue); Restore (two-step confirm) rewrites /work to that point — files created since are removed,
 * secrets and git branches untouched, and a safety checkpoint is saved first, so a restore is itself
 * restorable. */

const { snapshots, error, isLoading, refetch, diff, fileDiff, restore, busy, actionError } = useHistory();
// The gesture decides the tab: a click is a look (the strip's preview tab, replaced by the next file looked at),
// a double-click keeps it. See workspaceTabs' OpenMode.
const emit = defineEmits<{ "open-diff": [payload: DiffPayload, mode: OpenMode]; "fill-diff": [payload: DiffPayload] }>();

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
    restore: { title: `Files restored`, icon: `undo` },
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

// The tab opens on the click and the content fills it when the read lands — see DiffPayload's `pending`. A
// checkpoint's diff is two blob reads on the daemon like any other, and the wait belongs in the tab it is for.
const openDiff = (change: SnapshotChange, mode: OpenMode): void => {
    const snapshotId = selectedId.value;
    if (snapshotId === undefined) {
        return;
    }
    const tab = {
        key: snapshotId,
        scope: change.scope,
        label: changeLabel(change),
        status: change.status,
        path: change.path,
        // A checkpoint over an image ships no text either — the bytes come from /diff/raw, against this
        // same checkpoint so the preview shows what the row is about, not the file's state on disk.
        ...diffRawUrls({ source: `checkpoint`, snapshot: snapshotId, scope: change.scope }, change.path, change.status),
    };
    emit(`open-diff`, { ...tab, pending: true }, mode);
    void fileDiff(snapshotId, change.scope, change.path).then((body) => emit(`fill-diff`, { ...tab, ...body }));
};

const confirmRestore = (id: string): void => {
    confirmRestoreId.value = undefined;
    void restore(id);
};
</script>

<template>
    <div class="flex min-h-0 flex-1 flex-col">
        <div class="flex shrink-0 items-center gap-1 border-b border-line px-2 py-1.5">
            <span class="text-2xs font-medium uppercase tracking-wide text-subtle">Restore points</span>
            <span class="flex-1"></span>
            <Icon name="spinner" v-if="busy" class="text-xs text-muted" spin aria-label="Working" />
            <button type="button" :class="cmp.iconButton()" @click="refetch()" v-tooltip.right="'Refresh'" aria-label="Refresh restore points">
                <Icon name="refresh" class="text-xs" :spin="isLoading" />
            </button>
        </div>

        <p v-if="error" class="shrink-0 truncate px-2 py-1 text-2xs text-danger" v-tooltip.right.overflow="error">{{ error }}</p>
        <p v-if="actionError" class="shrink-0 truncate px-2 py-1 text-2xs text-danger" v-tooltip.right.overflow="actionError">{{ actionError }}</p>

        <div class="scrollbar-thin min-h-0 flex-1 overflow-auto py-1">
            <p v-if="snapshots.length === 0" class="px-3 py-2 text-2xs text-subtle">
                No restore points yet — file history is saved automatically as you and your agents work.
            </p>
            <div v-for="snapshot in snapshots" :key="snapshot.id" class="cv-row border-b border-line/50">
                <button
                    type="button"
                    class="flex w-full items-center gap-2 px-2 py-1.5 text-left transition-colors hover:bg-overlay max-md:min-h-11"
                    @click="select(snapshot)"
                >
                    <Icon class="text-2xs text-subtle" :name="selectedId === snapshot.id ? 'chevron-down' : 'chevron-right'" />
                    <Icon class="shrink-0 text-2xs text-muted" :name="TRIGGER_META[snapshot.trigger].icon" />
                    <span class="min-w-0 flex-1 truncate text-xs text-content" v-tooltip.right.overflow="snapshot.label">{{
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
                        @click="openDiff(change, 'preview')"
                        @dblclick="openDiff(change, 'keep')"
                    >
                        <ChangeStatusMark :status="change.status" />
                        <!-- <bdi> keeps a leading "_" ("_apps/…") from being reordered to the far right by dir="rtl";
                             the tooltip gives the whole path back, but only while the row is actually cut off. -->
                        <span class="truncate text-2xs text-muted max-md:text-xs" dir="rtl" v-tooltip.right.overflow="changeLabel(change)"
                            ><bdi>{{ changeLabel(change) }}</bdi></span
                        >
                    </button>

                    <div class="mt-1.5 flex items-center gap-2">
                        <template v-if="confirmRestoreId === snapshot.id">
                            <!-- The chat clause is not decoration: an open conversation is reasoning about the
                                 files this is about to move, and until it was told, the only symptom was its
                                 next turn behaving as though edits existed that no longer did. -->
                            <span class="flex-1 text-2xs text-warning"
                                >Rewrite all files to this restore point? Files created after it are removed; git branches and secrets are untouched.
                                Open chats working here are told the files moved.</span
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
                            v-tooltip.right="
                                'Files only — secrets and branches untouched. A safety restore point is saved first, and open chats are told.'
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
