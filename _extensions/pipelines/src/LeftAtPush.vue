<script setup lang="ts">
import type { AgentSummary } from "@intentic/sandbox-contract";
import { DisclosureRow, formatTimestamp, Icon, type NoticeModel, noticeFrom, noticeOf, RowGroup, timeAgo, ui } from "@intentic/extension-ui";
import { computed, ref } from "vue";
import PushDebtRow from "./PushDebtRow.vue";
import { owedFindings, type PushDebt, pushFixAttemptOf, type PushRecord, pushTitle } from "./pushChecks";
import type { PushChecksHands } from "./usePushChecks";
import { t } from "./i18n.js";

// LEFT AT PUSH: what the pre-push check found in the owner's pushes and let through, which is nobody's to fix until the
// owner says so. Each project that still owes something is a row (PushDebtRow.vue), most owed first; under them, the
// pushes the hook measured, newest first, each read as what it left. Drawn above the CI runs and never behind their
// load: a push is measured on the way out, before any pipeline has a word to say about it, and in a workspace with no
// forge connected at all this is the whole board.

const props = defineProps<{
    debts: readonly PushDebt[];
    record: readonly PushRecord[];
    // The fleet as the board read it, for each hand-over's live attempt.
    agents: readonly AgentSummary[];
    hands: PushChecksHands;
}>();
const emit = defineEmits<{
    // The receipt of the owner's last press, for the board's notice strip; undefined takes it down.
    notice: [notice: NoticeModel | undefined];
}>();

const owed = computed(() => owedFindings(props.debts));

// The workspace root is a project with no folder, and "" names nothing a reader can see.
const projectName = (project: string): string => (project === `` ? t(`leftAtPush.workspace`) : project);
// A project is worth naming on a push only when there is more than one it could be.
const manyProjects = computed(
    () => new Set([...props.record.map(({ push }) => push.project), ...props.debts.map(({ project }) => project)]).size > 1,
);

// Owned here rather than by the row: dismissing a project's last finding takes its row away, and the Undo with it.
const onDismissed = (project: string, ids: readonly string[], changed: number): void => {
    emit(
        `notice`,
        noticeOf(t(`leftAtPush.dismissed`, { count: changed }, changed), {
            tone: `info`,
            action: { label: t(`leftAtPush.undo`), run: () => void restore(project, ids) },
        }),
    );
};
const restore = async (project: string, ids: readonly string[]): Promise<void> => {
    emit(`notice`, undefined);
    try {
        await props.hands.dismiss(project, ids, true);
    } catch (error) {
        emit(`notice`, noticeFrom(error, t(`leftAtPush.restoreFailed`)));
    }
};

// THE RECORD, a glance at a time: the pushes as the daemon lists them, newest first.
const RECORD_SHOWN = 6;
const recordOpen = ref(false);
const recordAll = ref(false);
const recordShown = computed(() => (recordAll.value ? props.record : props.record.slice(0, RECORD_SHOWN)));
const recordHidden = computed(() => props.record.length - RECORD_SHOWN);

// What a push left: refused on the way out, still owed, all of it since settled, or nothing at all.
const outcome = (entry: PushRecord) => {
    if (entry.refused) {
        return { words: t(`leftAtPush.refused`), ink: `text-warning` };
    }
    if (entry.open > 0) {
        return { words: t(`leftAtPush.left`, { count: entry.open }, entry.open), ink: `text-warning` };
    }
    return entry.handled ? { words: t(`leftAtPush.handled`), ink: `text-muted` } : { words: t(`leftAtPush.clean`), ink: `text-success` };
};
const newest = computed(() => props.record[0]);
</script>

<template>
    <RowGroup :label="t(`leftAtPush.title`)" :count="owed > 0 ? owed : undefined" :caption="t(`leftAtPush.hint`)" data-left-at-push>
        <PushDebtRow
            v-for="debt in debts"
            :key="debt.project"
            :debt="debt"
            :name="projectName(debt.project)"
            :attempt="pushFixAttemptOf(debt.red, agents)"
            :hands="hands"
            @dismissed="(ids, changed) => onDismissed(debt.project, ids, changed)"
            @notice="(notice) => emit(`notice`, notice)"
        />

        <!-- The pushes themselves: the newest named on the header, every one a line in the drawer. -->
        <DisclosureRow v-if="newest !== undefined" data-push-record hit="pair" body="drawer" v-model:open="recordOpen">
            <template #lead="{ iconClass }">
                <Icon name="history" class="shrink-0 text-subtle" :class="iconClass" />
            </template>
            <template #title>
                <div class="flex min-w-0 items-center gap-2">
                    <span class="min-w-0 truncate text-sm text-content">{{ t(`leftAtPush.recent`) }}</span>
                    <span class="shrink-0 text-2xs text-subtle">{{ record.length }}</span>
                    <span v-if="debts.length === 0" class="min-w-0 truncate text-xs text-success">{{ t(`leftAtPush.nothingLeft`) }}</span>
                </div>
            </template>
            <template #description>
                <span class="flex flex-wrap items-center gap-x-2 gap-y-0.5 text-subtle">
                    <span class="font-mono text-muted">{{ pushTitle(newest.push) }}</span>
                    <span :class="outcome(newest).ink">{{ outcome(newest).words }}</span>
                    <span :title="formatTimestamp(newest.push.at)">{{ timeAgo(newest.push.at) }}</span>
                </span>
            </template>
            <template #below>
                <ul class="flex min-w-0 flex-col text-xs">
                    <li
                        v-for="entry in recordShown"
                        :key="entry.push.id"
                        data-push
                        class="flex min-h-7 min-w-0 items-center gap-3 rounded-md px-1.5 hover:bg-overlay"
                    >
                        <Icon name="arrow-up-right" class="shrink-0 text-2xs" :class="outcome(entry).ink" />
                        <span class="min-w-0 truncate font-mono text-muted">{{ pushTitle(entry.push) }}</span>
                        <span class="shrink-0" :class="outcome(entry).ink">{{ outcome(entry).words }}</span>
                        <span v-if="manyProjects" class="min-w-0 truncate text-subtle">{{ projectName(entry.push.project) }}</span>
                        <span class="ml-auto shrink-0 text-2xs tabular-nums text-subtle" :title="formatTimestamp(entry.push.at)">{{
                            timeAgo(entry.push.at, { days: true })
                        }}</span>
                    </li>
                </ul>
                <!-- The record's tail, not a pager: the count is the point, and the rest stay one press away. -->
                <button
                    v-if="recordHidden > 0 && !recordAll"
                    type="button"
                    :class="ui.textAction(`mt-1 min-h-7 pl-1.5 text-2xs text-subtle`)"
                    @click="recordAll = true"
                >
                    {{ t(`leftAtPush.earlierPushes`, { count: recordHidden }, recordHidden) }}
                </button>
            </template>
        </DisclosureRow>
    </RowGroup>
</template>
