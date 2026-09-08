<script setup lang="ts">
import type { SnapshotChange, SnapshotTrigger, WorkspaceSnapshot } from "@intentic/api-contract";
import { ref } from "vue";
import { diffRawUrls } from "./diffRaw";
import { useHistory } from "./useHistory";
import { Button, ChangeStatusMark, ui, type IconName, Notice, timeAgo } from "@intentic/ui";
import type { DiffPayload } from "@intentic/extension-api";
import type { OpenMode } from "../tabs/workspaceTabs";

// Restore-point timeline: daemon checkpoints of /work (not git), from agent turns, user changes, and restore markers.
// Selecting one lazy-loads what changed since the previous checkpoint; a file opens a diff tab. Restore rewrites /work
// to that point, leaving secrets and git branches untouched, after saving a safety checkpoint first.

const { snapshots, error, isLoading, refetch, diff, fileDiff, restore, busy, actionError } = useHistory();
// Click opens a preview tab (replaced by the next file looked at); double-click keeps it, see OpenMode.
const emit = defineEmits<{ "open-diff": [payload: DiffPayload, mode: OpenMode]; "fill-diff": [payload: DiffPayload] }>();

const selectedId = ref<string | undefined>(undefined);
const changes = ref<readonly SnapshotChange[]>([]);
const diffLoading = ref(false);
const confirmRestoreId = ref<string | undefined>(undefined);

// Fallback title/icon per trigger; a snapshot's own label wins as the row title. `interval` never appears here.
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

// Opens the tab immediately; content fills in when the read lands (DiffPayload's `pending`). A checkpoint diff is two
// blob reads on the daemon, so the wait belongs to the tab it's for.
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
        // An image ships no text either; bytes come from /diff/raw against this same checkpoint.
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
            <button type="button" :class="ui.iconButton()" @click="refetch()" v-tooltip.right="'Refresh'" aria-label="Refresh restore points">
                <Icon name="refresh" class="text-xs" :spin="isLoading" />
            </button>
        </div>

        <p v-if="error" class="shrink-0 truncate px-2 py-1 text-2xs text-danger" v-tooltip.right.overflow="error">{{ error }}</p>
        <Notice v-if="actionError" :of="actionError" class="mx-2 shrink-0" />

        <div class="scrollbar-thin min-h-0 flex-1 overflow-auto py-1">
            <p v-if="snapshots.length === 0" class="px-3 py-2 text-2xs text-subtle">
                No restore points yet: file history is saved automatically as you and your agents work.
            </p>
            <!-- No hairline per row; the open row gets a tint instead, which is where a boundary is actually needed. -->
            <div v-for="snapshot in snapshots" :key="snapshot.id" class="cv-row" :class="selectedId === snapshot.id ? `bg-content/4` : ``">
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
                        <!-- `<bdi>` stops a leading '_' from reordering under dir="rtl"; the tooltip shows the full path only while truncated. -->
                        <span class="truncate text-2xs text-muted max-md:text-xs" dir="rtl" v-tooltip.right.overflow="changeLabel(change)"
                            ><bdi>{{ changeLabel(change) }}</bdi></span
                        >
                    </button>

                    <div class="mt-1.5 flex items-center gap-2">
                        <template v-if="confirmRestoreId === snapshot.id">
                            <!-- Not decoration: an open chat is reasoning about these files and must be told they moved. -->
                            <span class="flex-1 text-2xs text-warning"
                                >Rewrite all files to this restore point? Files created after it are removed; git branches and secrets are untouched.
                                Open chats working here are told the files moved.</span
                            >
                            <Button size="small" severity="danger" @click="confirmRestore(snapshot.id)"> Restore </Button>
                            <Button size="small" severity="secondary" :text="true" label="Cancel" @click="confirmRestoreId = undefined" />
                        </template>
                        <Button
                            v-else
                            size="small"
                            severity="secondary"
                            :disabled="busy"
                            @click="confirmRestoreId = snapshot.id"
                            v-tooltip.right="
                                'Files only: secrets and branches untouched. A safety restore point is saved first, and open chats are told.'
                            "
                        >
                            <Icon name="history" class="mr-1 text-2xs" />Restore
                        </Button>
                    </div>
                </div>
            </div>
        </div>
    </div>
</template>

<style scoped>
/*
 * Cheap windowing without a virtual scroller: content-visibility skips paint for off-screen rows.
 * contain-intrinsic-size keeps the scrollbar stable before a row first renders.
 */
.cv-row {
    content-visibility: auto;
    contain-intrinsic-size: auto 34px;
}
.cv-file {
    content-visibility: auto;
    contain-intrinsic-size: auto 22px;
}
</style>
