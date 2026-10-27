<script setup lang="ts">
import { SANDBOX_RECOVERY_DAYS as RECOVERY_DAYS } from "@intentic/api-contract";
import { Button, Notice, type NoticeModel, Page, PageHeader, Row, RowGroup, RowNote, SandboxLogo, SkeletonRows, toneInk } from "@intentic/ui";
import { formatDateTime, formatDayMonthTime } from "@intentic/ui/format";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { useSandbox } from "../../client/sandbox/useSandbox";
import ProgressMeter from "../../components/progress/ProgressMeter.vue";
import { useBusySince, useProgress } from "../../components/progress/useProgress";
import { daysLeft, trashLanes, trashState } from "../../models/home/trashWindow";
import { useSandboxTrash } from "../../models/home/sandboxTrash";

// THE ACCOUNT'S DELETED SANDBOXES, a page of the account's beside Settings (lib/routes/home.ts `DELETED_PATH`), reached
// from the foot of every list of the account's sandboxes (the switcher, Home) and from a removal's receipt. Not a
// section of any one sandbox's screen: it sat at the foot of a sandbox's Devices board until 2026-10-27, where boxes
// that never ran anywhere near that sandbox read as if they had. Recovery must also work with no sandbox left at all.
//
// One list per lane, since the lane decides what a restore brings back: said once over its list, not under every row.
// A row is the box as the switcher drew it (its logo and name), when it was deleted, which is what tells two boxes of
// one name apart, and how long it can still come back.

const t = useT();
const sandbox = useSandbox();
const trash = useSandboxTrash();

const state = computed(() =>
    trashState({ rows: trash.recoverable.value.length, read: trash.deleted.value !== undefined, readError: trash.readError.value !== undefined }),
);
const lanes = computed(() => trashLanes(trash.recoverable.value));


// A failed restore and a failed read are both said above the lists; a failed re-read leaves the rows it had.
const notice = computed<NoticeModel | undefined>(() => {
    if (trash.failed.value !== undefined) {
        return { tone: `danger`, title: t(`sandbox.recentlyDeleted.couldntRestore`), detail: trash.failed.value };
    }
    if (trash.readError.value !== undefined) {
        return { tone: `danger`, title: t(`sandbox.recentlyDeleted.couldntRead`), detail: trash.readError.value };
    }
    return undefined;
});

// How long a restore has run, under its row: bringing a hosted machine back is the platform's work and is not instant.
const restoreWait = useProgress(useBusySince(() => trash.restoring.value !== undefined));

// Restoring makes it the active sandbox: the reader asked for that box back, and an own-machine one has a connection
// to set up again, which is the next thing its screen asks for.
const restore = async (trashId: string): Promise<void> => {
    const restored = await trash.restore(trashId);
    if (restored !== undefined) {
        sandbox.select(restored.id);
    }
};
</script>

<template>
    <Page>
        <PageHeader
            :title="t(`sandbox.words.recentlyDeleted`)"
            :description="t(`sandbox.recentlyDeleted.window`, { count: RECOVERY_DAYS }, RECOVERY_DAYS)"
        />

        <div class="flex flex-col gap-6">
            <Notice v-if="notice" :of="notice" />

            <RowGroup v-if="state === `reading`">
                <div role="status" aria-busy="true">
                    <span class="sr-only">{{ t(`sandbox.recentlyDeleted.reading`) }}</span>
                    <SkeletonRows :rows="2" description control />
                </div>
            </RowGroup>

            <RowGroup v-else-if="state === `empty`">
                <RowNote variant="empty">{{ t(`sandbox.recentlyDeleted.nothingToRestore`) }}</RowNote>
            </RowGroup>

            <RowGroup
                v-for="group in lanes"
                :key="group.lane"
                :label="group.lane === `cloud` ? t(`sandbox.placement.cloudLabel`) : t(`sandbox.recentlyDeleted.ownLane`)"
            >
                <RowNote>{{
                    group.lane === `cloud` ? t(`sandbox.recentlyDeleted.comesBackWithMachine`) : t(`sandbox.recentlyDeleted.comesBackAsName`)
                }}</RowNote>
                <Row
                    v-for="row in group.rows"
                    :key="row.id"
                    :title="row.name"
                    :description="t(`sandbox.recentlyDeleted.deletedAt`, { when: formatDayMonthTime(Date.parse(row.deletedAt)) })"
                >
                    <template #lead="{ mark }"><SandboxLogo :size="mark" :image="row.image" :name="row.name" /></template>
                    <!-- The last day in the warning's ink: the one row that will not be here tomorrow. -->
                    <template #meta>
                        <span
                            class="text-2xs"
                            :class="daysLeft(row.purgeAfter) === 1 ? toneInk(`warning`) : `text-subtle`"
                            :title="t(`sandbox.recentlyDeleted.goneAt`, { when: formatDateTime(Date.parse(row.purgeAfter)) })"
                            >{{ t(`sandbox.recentlyDeleted.daysLeftToRestore`, { count: daysLeft(row.purgeAfter) }, daysLeft(row.purgeAfter)) }}</span
                        >
                    </template>
                    <!-- Quiet: the same press down every row, so the list does not become a column of boxes. -->
                    <template #control>
                        <Button
                            size="small"
                            tier="quiet"
                            :label="t(`ui.action.restore`)"
                            :loading="trash.restoring.value === row.id"
                            :disabled="trash.restoring.value !== undefined"
                            @click="void restore(row.id)"
                        />
                    </template>
                    <template v-if="restoreWait && trash.restoring.value === row.id" #below>
                        <ProgressMeter
                            :progress="restoreWait"
                            :what="row.hosted ? t(`sandbox.recentlyDeleted.restoringHostedNote`) : t(`sandbox.recentlyDeleted.restoringOwnNote`)"
                        />
                    </template>
                </Row>
            </RowGroup>
        </div>
    </Page>
</template>
