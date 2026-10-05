<script setup lang="ts">
import { Button, Notice, type NoticeModel, Row, RowGroup, SkeletonRows, SkeletonSnapshot, ui, vSkeletonSource } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { useSandbox } from "../client/useSandbox";
import { daysLeft } from "../client/trashWindow";
import { useSandboxTrash } from "../client/useSandboxTrash";

// Sandboxes this account deleted that the platform still holds. Account-wide, not about the active box: it lives in
// the hub rather than the rail's switcher so a run of test deletions never crowds the list of places to go.

const t = useT();
const sandbox = useSandbox();
const trash = useSandboxTrash();

const notice = computed<NoticeModel | undefined>(() => {
    if (trash.failed.value !== undefined) {
        return { tone: `danger`, title: t(`sandbox.sandboxDeleted.couldntRestore`), detail: trash.failed.value };
    }
    if (trash.readError.value !== undefined) {
        return { tone: `danger`, title: t(`sandbox.sandboxDeleted.couldntRead`), detail: trash.readError.value };
    }
    return undefined;
});

const restore = async (trashId: string): Promise<void> => {
    const restored = await trash.restore(trashId);
    if (restored !== undefined) {
        sandbox.select(restored.id);
    }
};
</script>

<template>
    <div class="flex flex-col gap-6">
        <Notice v-if="notice" :of="notice" />

        <!-- Drawn as the list (or its empty state) last looked from this sandbox. -->
        <SkeletonSnapshot
            v-if="trash.deleted.value === undefined && trash.readError.value === undefined"
            of="sandbox.deleted"
            :label="t(`sandbox.sandboxDeleted.reading`)"
        >
            <RowGroup :label="t(`sandbox.words.recentlyDeleted`)">
                <div role="status" aria-busy="true">
                    <span class="sr-only">{{ t(`sandbox.sandboxDeleted.reading`) }}</span>
                    <SkeletonRows :rows="2" description control />
                </div>
            </RowGroup>
        </SkeletonSnapshot>

        <div
            v-else-if="trash.recoverable.value.length === 0"
            v-skeleton-source="`sandbox.deleted`"
            :class="ui.emptyState('flex flex-col items-center gap-3 py-8')"
        >
            <Icon name="trash" class="text-xl text-subtle" />
            <span class="text-sm font-medium text-content">{{ t(`sandbox.sandboxDeleted.nothingToRestore`) }}</span>
        </div>

        <RowGroup v-else v-skeleton-source="`sandbox.deleted`" :label="t(`sandbox.words.recentlyDeleted`)" equal-rows>
            <Row
                v-for="row in trash.recoverable.value"
                :key="row.id"
                icon="server"
                :title="row.name"
                :description="row.hosted ? t(`sandbox.sandboxDeleted.comesBackWithMachine`) : t(`sandbox.sandboxDeleted.comesBackAsName`)"
            >
                <template #meta>
                    <span class="text-2xs text-subtle">{{
                        t(`sandbox.sandboxDeleted.daysLeftToRestore`, { count: daysLeft(row.purgeAfter) }, daysLeft(row.purgeAfter))
                    }}</span>
                </template>
                <template #control>
                    <Button
                        size="small"
                        severity="secondary"
                        :label="t(`ui.action.restore`)"
                        :loading="trash.restoring.value === row.id"
                        :disabled="trash.restoring.value !== undefined"
                        @click="void restore(row.id)"
                    />
                </template>
            </Row>
        </RowGroup>
    </div>
</template>
