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

/* Issues: the bugs your own users hit, as they arrived from the reporter embedded on your sites and apps.
 *
 * THE LIST IS GROUPS, NOT EVENTS, and that is the whole reason this page is readable. A crash that hit a
 * thousand browsers is ONE row with a count, because the daemon fingerprints every report before it is stored
 * (issues/fingerprint.ts). An event log would be a thousand rows saying the same thing, and the count, which is
 * the only number that tells you which bug to fix first, would have to be derived by eye.
 *
 * NOTHING HERE CREATES ONE, unlike Drafts, which this page is otherwise shaped like. Reports arrive at a public
 * endpoint and the daemon writes them; this side triages. So the actions are: put an agent on it, file it away,
 * reopen it, throw it out.
 *
 * THREE SECTIONS, IN THE ORDER THEY OWE A DECISION. Waiting on you, being looked at, and dealt with. A status
 * badge survives only where its section does not already state it, which is why an `open` row carries none: it
 * is the resting state and the majority of the list, and a badge on every row is a badge nobody reads.
 *
 * WHAT CAME BACK IS THE LOUDEST THING ON THE PAGE. The daemon reopens a resolved group when it happens again,
 * so an open row that has already had a turn is a fix that did not hold, and that is worth a warning tone where
 * a merely new crash gets none. It is the one thing this inbox knows that reading any single report cannot say.
 *
 * THE EVIDENCE IS UNDER THE ROW, not on another page. Deciding whether a bug is worth a turn means reading the
 * stack and what led up to it, and a decision that needs a navigation is one people make from the title alone.
 *
 * EVERYTHING IN THE EVIDENCE CAME FROM A STRANGER'S BROWSER, and is rendered as text, never as markup. */

const { issues, invalid, isLoading, error: listError, setStatus, investigate, remove } = useIssues();
const now = useNow();
const { notice: actionError, run } = useAsyncAction();

// Only drawn once the wait has earned it: a warm inbox answers well inside the reveal delay.
const outline = useLoadingReveal(
    isLoading,
    computed(() => `issues`),
);
const listNotice = computed<NoticeModel | undefined>(() =>
    listError.value === undefined ? undefined : { tone: `danger`, title: `Couldn't read your issues.`, detail: listError.value },
);

/* Starting a turn spends the owner's account and lands a change in the repo, so it is the ship tier, the same
 * floor the daemon puts on the routes themselves. Below it this page is a read: what your users are hitting,
 * how often, and whether anything is being done about it, which is exactly what a viewer is for. */
const canShip = computed(() => roleAtLeast(host().sandbox.role(), `maintainer`));

const openIssues = computed(() => issues.value.filter((issue) => issue.status === `open`));
const working = computed(() => issues.value.filter((issue) => issue.status === `investigating`));
const settled = computed(() => issues.value.filter((issue) => issue.status === `resolved` || issue.status === `ignored`));
const isEmpty = computed(() => issues.value.length === 0 && invalid.value.length === 0);

// Which row is opened. One at a time: two stacks on screen at once is two things being compared that are not
// comparable, and the accordion keeps the page a list rather than a wall.
const opened = ref<string | undefined>(undefined);
const toggle = (id: string, open: boolean): void => {
    opened.value = open ? id : undefined;
};

const discarding = ref<IssueSummary | undefined>(undefined);

/* Every triage gesture is one mutation and one sentence to show if it fails. The sentence is required by
 * `run` and belongs here rather than at the throw site: the daemon can say a request 404'd, only this page
 * knows the owner was trying to reopen a bug. */
const act = (work: () => Promise<unknown>, wrote: string): void =>
    void run(async () => {
        await work();
    }, wrote);

const forget = (issue: IssueSummary): void => {
    discarding.value = undefined;
    act(() => remove.mutateAsync(issue.id), `Could not forget that issue.`);
};

/* Opening the run an agent is already on, rather than starting a second one. A bug being worked on has a
 * conversation, and offering to start another turn on it is how two worktrees end up editing one file. */
const openRun = (conversationId: string): void => host().chat.openSession(conversationId);
</script>

<template>
    <!-- `scroll="page"`: a feed, so the page scrolls it. There is no rail on this screen at all, which makes the
         clamp even harder to defend — it was a scrollbar inside a card inside a page, in aid of keeping an index
         on screen that does not exist here. -->
    <SplitView title="Issues" scroll="page" description="Bugs your own users hit, grouped so one crash is one row however many people it reached.">
        <!-- Above the split rather than inside it: a failure to read the inbox is not about any one row. -->
        <template #strips>
            <NoticeStack :of="[actionError, listNotice]" />
            <!-- Nothing but the daemon writes these files, so one that will not parse is a real fault here
                 rather than a typo somebody made, and it is worth saying out loud rather than skipping. -->
            <Notice v-if="invalid.length > 0" tone="warning">
                {{ invalid.length }} issue file{{ invalid.length === 1 ? "" : "s" }} couldn't be read:
                <span class="font-mono">{{ invalid.join(", ") }}</span>
            </Notice>
        </template>

        <template #detail>
            <!-- No `pr-1` either: that gutter existed to keep the rows' trailing controls off this pane's own
                 scrollbar thumb, and the pane no longer has one. -->
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

                    <!-- Kept rather than hidden: "we fixed this in March" is the context that makes a recurrence
                         legible, and it is the row the daemon reopens when the same crash comes back. -->
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

                <!-- Confirmed, because forgetting one loses its history: how long it ran, how many people it reached,
                     and what was already tried. It comes back as NEW if it happens again, which is the sentence that
                     makes the choice answerable. -->
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
