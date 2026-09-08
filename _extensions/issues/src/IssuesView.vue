<script setup lang="ts">
import { type IssueSummary, roleAtLeast } from "@intentic/sandbox-contract";
import {
    Button,
    ConfirmDialog,
    DisclosureRow,
    Notice,
    NoticeStack,
    Row,
    RowGroup,
    SkeletonRows,
    SplitView,
    StatusBadge,
    timeAgo,
    type NoticeModel,
    ui,
    useAsyncAction,
    useLoadingReveal,
    useNow,
} from "@intentic/extension-ui";
import { computed, ref } from "vue";
import { host } from "./host";
import IssueEvidence from "./IssueEvidence.vue";
import { primaryAction, returned, shortId, statusBadge, timesWords, whereWords } from "./issueText";
import { useIssues } from "./useIssues";

// Issue reports from your own users, grouped by fingerprint: one row per bug with a count, not one per event. This page
// only triages (investigate/resolve/ignore/reopen/forget); the daemon creates reports. Evidence lives under the row,
// not on another page.

const { issues, invalid, isLoading, error: listError, setStatus, investigate, remove } = useIssues();
const now = useNow();
const { notice: actionError, run } = useAsyncAction();

// Only drawn once the wait has earned it: a warm inbox answers within the reveal delay.
const outline = useLoadingReveal(
    isLoading,
    computed(() => `issues`),
);
const listNotice = computed<NoticeModel | undefined>(() =>
    listError.value === undefined ? undefined : { tone: `danger`, title: `Couldn't read your issues.`, detail: listError.value },
);

// Starting a turn is the ship tier, the same floor as the routes; below it the page is read-only.
const canShip = computed(() => roleAtLeast(host().sandbox.role(), `maintainer`));

const openIssues = computed(() => issues.value.filter((issue) => issue.status === `open`));
const working = computed(() => issues.value.filter((issue) => issue.status === `investigating`));
const settled = computed(() => issues.value.filter((issue) => issue.status === `resolved` || issue.status === `ignored`));
const isEmpty = computed(() => issues.value.length === 0 && invalid.value.length === 0);

// One row open at a time, kept as an accordion rather than a list of expanded stacks.
const opened = ref<string | undefined>(undefined);
const toggle = (id: string, open: boolean): void => {
    opened.value = open ? id : undefined;
};

const discarding = ref<IssueSummary | undefined>(undefined);

// One mutation per gesture, with the failure message supplied here rather than at the throw site: only the caller knows
// what the owner was trying to do.
const act = (work: () => Promise<unknown>, wrote: string): void =>
    void run(async () => {
        await work();
    }, wrote);

const forget = (issue: IssueSummary): void => {
    discarding.value = undefined;
    act(() => remove.mutateAsync(issue.id), `Could not forget that issue.`);
};

// Opens the run already in progress on a bug instead of starting a second one on it.
const openRun = (conversationId: string): void => host().chat.openSession(conversationId);
</script>

<template>
    <!-- `scroll="page"`: a feed, so the page scrolls it; this screen has no rail of its own. -->
    <SplitView title="Issues" scroll="page">
        <!-- Above the split, not inside it: a failed read isn't about any one row. -->
        <template #strips>
            <NoticeStack :of="[actionError, listNotice]" />
            <!-- Only the daemon writes these files; one that fails to parse is a real fault, not a typo. -->
            <Notice v-if="invalid.length > 0" tone="warning">
                {{ invalid.length }} issue file{{ invalid.length === 1 ? "" : "s" }} couldn't be read:
                <span class="font-mono">{{ invalid.join(", ") }}</span>
            </Notice>
        </template>

        <template #detail>
            <!-- No `pr-1` gutter: this pane has no scrollbar of its own to clear. -->
            <div class="flex flex-col gap-4">
                <template v-if="outline">
                    <RowGroup role="status" aria-busy="true">
                        <template #label><span class="skeleton block h-2.5 w-24" aria-hidden="true" /></template>
                        <span class="sr-only">Reading your issues…</span>
                        <SkeletonRows :rows="3" description control />
                    </RowGroup>
                </template>

                <p v-else-if="isEmpty" :class="ui.emptyState(`py-8`)">
                    Nothing reported yet. Crashes and problem reports from the sites and apps you embedded the reporter on land here, grouped by what
                    went wrong.
                </p>

                <template v-else>
                    <RowGroup v-if="openIssues.length > 0" label="Waiting on you" :count="openIssues.length">
                        <DisclosureRow
                            v-for="issue in openIssues"
                            :key="issue.id"
                            :title="issue.title"
                            :description="whereWords(issue)"
                            :tone="returned(issue) ? `warning` : undefined"
                            :open="opened === issue.id"
                            @update:open="(open: boolean) => toggle(issue.id, open)"
                        >
                            <template #control>
                                <span class="text-sm text-muted tabular-nums"
                                    >{{ timesWords(issue.count) }} · {{ timeAgo(issue.lastSeen, { now }) }}</span
                                >
                                <!-- The one fact a status cannot carry: this was fixed and it is back. -->
                                <StatusBadge v-if="returned(issue)" variant="warning" label="came back" size="sm" />
                                <template v-if="canShip">
                                    <Button
                                        label="Investigate"
                                        size="small"
                                        :disabled="investigate.isPending.value"
                                        @click="act(() => investigate.mutateAsync(issue.id), `Could not put an agent on that issue.`)"
                                    />
                                    <Button
                                        label="Resolve"
                                        size="small"
                                        severity="secondary"
                                        :disabled="setStatus.isPending.value"
                                        @click="
                                            act(() => setStatus.mutateAsync({ id: issue.id, status: `resolved` }), `Could not resolve that issue.`)
                                        "
                                    />
                                    <Button
                                        label="Ignore"
                                        size="small"
                                        severity="secondary"
                                        text
                                        :disabled="setStatus.isPending.value"
                                        @click="act(() => setStatus.mutateAsync({ id: issue.id, status: `ignored` }), `Could not ignore that issue.`)"
                                    />
                                </template>
                            </template>
                            <template #below><IssueEvidence :issue="issue" /></template>
                        </DisclosureRow>
                    </RowGroup>

                    <RowGroup v-if="working.length > 0" label="Being looked at" :count="working.length">
                        <DisclosureRow
                            v-for="issue in working"
                            :key="issue.id"
                            :title="issue.title"
                            :description="whereWords(issue)"
                            :open="opened === issue.id"
                            @update:open="(open: boolean) => toggle(issue.id, open)"
                        >
                            <template #control>
                                <span class="text-sm text-muted tabular-nums">{{ timesWords(issue.count) }}</span>
                                <Button
                                    v-if="canShip && primaryAction(issue).kind === `open`"
                                    label="Open the run"
                                    size="small"
                                    severity="secondary"
                                    @click="openRun((primaryAction(issue) as { conversationId: string }).conversationId)"
                                />
                                <Button
                                    v-if="canShip"
                                    label="Resolve"
                                    size="small"
                                    severity="secondary"
                                    :disabled="setStatus.isPending.value"
                                    @click="act(() => setStatus.mutateAsync({ id: issue.id, status: `resolved` }), `Could not resolve that issue.`)"
                                />
                            </template>
                            <template #below><IssueEvidence :issue="issue" /></template>
                        </DisclosureRow>
                    </RowGroup>

                    <!-- Kept, not hidden: past fixes give context, and this is the row the daemon reopens on recurrence. -->
                    <RowGroup v-if="settled.length > 0" label="Dealt with" :count="settled.length">
                        <Row v-for="issue in settled" :key="issue.id" :title="issue.title" :description="whereWords(issue)">
                            <template #control>
                                <span class="text-sm text-muted tabular-nums">{{ shortId(issue.id) }}</span>
                                <StatusBadge
                                    v-if="statusBadge(issue.status)"
                                    :variant="statusBadge(issue.status)!.tone"
                                    :label="statusBadge(issue.status)!.label"
                                    size="sm"
                                />
                                <template v-if="canShip">
                                    <Button
                                        label="Reopen"
                                        size="small"
                                        severity="secondary"
                                        text
                                        :disabled="setStatus.isPending.value"
                                        @click="act(() => setStatus.mutateAsync({ id: issue.id, status: `open` }), `Could not reopen that issue.`)"
                                    />
                                    <Button label="Forget" size="small" severity="danger" text @click="discarding = issue" />
                                </template>
                            </template>
                        </Row>
                    </RowGroup>
                </template>

                <!-- Confirmed because forgetting drops its history; it returns as a new issue if it happens again. -->
                <ConfirmDialog
                    :open="discarding !== undefined"
                    header="Forget this issue?"
                    confirm-label="Forget"
                    confirm-icon="trash"
                    :loading="remove.isPending.value"
                    @cancel="discarding = undefined"
                    @confirm="discarding && forget(discarding)"
                >
                    <p v-if="discarding" class="text-sm text-muted">
                        “{{ discarding.title }}” and everything recorded about it — how often it happened and what has been tried — are dropped. If it
                        happens again it comes back as a new issue.
                    </p>
                </ConfirmDialog>
            </div>
        </template>
    </SplitView>
</template>
