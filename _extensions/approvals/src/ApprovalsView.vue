<script setup lang="ts">
import {
    type ActionApprovalSummary,
    type ApprovalSummary,
    type AutomationApproval,
    type PostApprovalSummary,
    roleAtLeast,
} from "@intentic/sandbox-contract";
import {
    BrandMark,
    Button,
    ui,
    ConfirmDialog,
    formatTimestamp,
    type IconName,
    Notice,
    noticeOf,
    NoticeStack,
    Row,
    RowGroup,
    SkeletonRows,
    SplitView,
    StatusBadge,
    timeAgo,
    type NoticeModel,
    useAsyncAction,
    useLoadingReveal,
    useNow,
    vAction,
} from "@intentic/extension-ui";
import { computed, ref } from "vue";
import ActionBody from "./ActionBody.vue";
import ApprovalMeta from "./ApprovalMeta.vue";
import ApprovalRail, { type ApprovalScope } from "./ApprovalRail.vue";
import { host } from "./host";
import PostBody from "./PostBody.vue";
import { countdownWords, limitOf, postsATitle } from "./postText";
import PostEditor from "./PostEditor.vue";
import ScheduleControl from "./ScheduleControl.vue";
import { useApprovals } from "./useApprovals";
import { useHeldWakes, waitingOf } from "./useHeldWakes";
import { usePlatformCatalog } from "./usePlatformCatalog";
import { usePostEdit } from "./usePostEdit";

// The approval inbox: the agent proposes a post or an action, and only the owner's click makes it real. Approving isn't
// instant: it starts a one-minute hold with a live countdown and a way to call it back. Sections are ordered by what's
// owed: broken, needs review, about to happen, scheduled, done.

const { approvals, invalid, isLoading, error: listError, save, remove } = useApprovals();
const { held, error: heldError, approve: approveWake, reject: rejectWake } = useHeldWakes();
// Only drawn once the wait has earned it; a warm queue answers within the reveal delay.
const outline = useLoadingReveal(
    isLoading,
    computed(() => `approvals`),
);
// The list queries know they failed and nothing else; this page knows what the user came for.
const listNotice = computed<NoticeModel | undefined>(() =>
    listError.value === undefined ? undefined : { tone: `danger`, title: `Couldn't read your approvals.`, detail: listError.value },
);
const heldNotice = computed<NoticeModel | undefined>(() =>
    heldError.value === undefined ? undefined : { tone: `danger`, title: `Couldn't read the held automations.`, detail: heldError.value },
);
// Below maintainer, the queue is read-only (the daemon floors the mutation too); a viewer can still watch.
const canShip = computed(() => roleAtLeast(host().sandbox.role(), `maintainer`));
const { notice: actionError, run } = useAsyncAction();

const isPost = (item: ApprovalSummary): item is PostApprovalSummary => item.kind === `post`;
const isAction = (item: ApprovalSummary): item is ActionApprovalSummary => item.kind === `action`;

// Platform display data from the enabled extensions' catalogs; falls back to a monogram if none is installed.
const platformCatalog = usePlatformCatalog();
// Keyed by platform id directly, since the rail's own rows are platforms with no post to read an id off. Capitalised
// here, not in CSS, since the same string is also a Picker option and a tooltip.
const nameOfPlatform = (platform: string): string =>
    platformCatalog.value.get(platform)?.name ?? `${platform.charAt(0).toUpperCase()}${platform.slice(1)}`;
const logoOfPlatform = (platform: string): string | undefined => platformCatalog.value.get(platform)?.logo;
// What the meta line calls the item: the platform's name for a post, and plainly "Action" for an action.
const nameOf = (item: ApprovalSummary): string => (isPost(item) ? nameOfPlatform(item.platform) : `Action`);
const targetOf = (item: ApprovalSummary): string | undefined => (isPost(item) ? item.target : undefined);

// Rows are the slices the queue actually holds, not ones it merely could: an empty slice has no way back. Platforms
// sort alphabetically; actions and automations sort last.
const ACTIONS_SCOPE = `actions`;
const AUTOMATIONS_SCOPE = `automations`;
const scopeOf = (key: string, label: string, subset: readonly ApprovalSummary[], mark: { logo?: string; icon?: IconName }): ApprovalScope => ({
    key,
    label,
    ...mark,
    total: subset.length,
    waiting: subset.filter((item) => item.status === `proposed`).length,
    failed: subset.filter((item) => item.status === `failed`).length,
});
// The held wakes counted into the same shape: every one is a row, and the ones with no deadline are waiting.
const wakesScope = computed<ApprovalScope>(() => ({
    key: AUTOMATIONS_SCOPE,
    label: `Automations`,
    icon: `clock`,
    total: held.value.length,
    waiting: waitingOf(held.value).length,
    failed: 0,
}));
const allScope = computed<ApprovalScope>(() => {
    const own = scopeOf(``, `All approvals`, approvals.value, { icon: `check-square` });
    return { ...own, total: own.total + wakesScope.value.total, waiting: own.waiting + wakesScope.value.waiting };
});
const scopes = computed<ApprovalScope[]>(() => {
    const posts = approvals.value.filter(isPost);
    const platforms = [...new Set(posts.map((post) => post.platform))]
        .map((platform) =>
            scopeOf(
                platform,
                nameOfPlatform(platform),
                posts.filter((post) => post.platform === platform),
                { logo: logoOfPlatform(platform) },
            ),
        )
        .toSorted((left, right) => left.label.localeCompare(right.label));
    const actions = approvals.value.filter(isAction);
    return [
        ...platforms,
        ...(actions.length === 0 ? [] : [scopeOf(ACTIONS_SCOPE, `Actions`, actions, { icon: `bolt` })]),
        ...(held.value.length === 0 ? [] : [wakesScope.value]),
    ];
});

// Replaced not pushed (Back leaves the page); falls back to all when the linked slice is gone.
const scope = computed<string>({
    get: () => host().route.query()[`scope`] ?? ``,
    set: (value) => host().route.setQuery({ scope: value === `` ? undefined : value }),
});
const activeScope = computed<ApprovalScope>(() => scopes.value.find((entry) => entry.key === scope.value) ?? allScope.value);
const railScope = computed<string>({ get: () => activeScope.value.key, set: (value) => (scope.value = value) });

// What the sections below are built from; the countdown strip reads the whole queue instead (`holding`).
const inScope = (item: ApprovalSummary, key: string): boolean => {
    if (key === ``) {
        return true;
    }
    if (key === ACTIONS_SCOPE) {
        return isAction(item);
    }
    return key !== AUTOMATIONS_SCOPE && isPost(item) && item.platform === key;
};
const visible = computed<ApprovalSummary[]>(() => approvals.value.filter((item) => inScope(item, activeScope.value.key)));
// The held wakes are shown on the whole queue and on their own slice, never inside a platform's.
const heldVisible = computed<AutomationApproval[]>(() =>
    activeScope.value.key === `` || activeScope.value.key === AUTOMATIONS_SCOPE ? held.value : [],
);

// Soonest first, undated last: undated still goes ahead immediately, but it's owed a decision about when.
const due = (item: ApprovalSummary): number => item.scheduledAt ?? Number.MAX_SAFE_INTEGER;
const bySoonest = (left: ApprovalSummary, right: ApprovalSummary): number => due(left) - due(right);

const ofStatus = (...statuses: ApprovalSummary[`status`][]): ApprovalSummary[] => visible.value.filter((item) => statuses.includes(item.status));

// Going ahead (imminent, or already running) needs a stop button; Scheduled needs a date control. The window is wider
// than the hold itself, since a two-minute-out item is just as urgent.
const GOING_AHEAD_WINDOW = 2 * 60_000;
const imminent = (item: ApprovalSummary, at: number): boolean => item.status === `running` || (item.scheduledAt ?? 0) - at <= GOING_AHEAD_WINDOW;

// Ticks only while something is approved or running, off the whole queue (the strip it drives isn't scoped to a slice).
// Not keyed on "is anything counting down": that depends on `now` itself.
const now = useNow(
    () =>
        approvals.value.some((item) => item.status === `approved` || item.status === `running`) ||
        held.value.some((wake) => wake.autoRunAt !== undefined),
);

const failed = computed(() => ofStatus(`failed`).toSorted(bySoonest));
const needsReview = computed(() => ofStatus(`proposed`).toSorted(bySoonest));
const goingAhead = computed(() =>
    ofStatus(`approved`, `running`)
        .filter((item) => imminent(item, now.value))
        .toSorted(bySoonest),
);
const scheduled = computed(() =>
    ofStatus(`approved`)
        .filter((item) => !imminent(item, now.value))
        .toSorted(bySoonest),
);
// Newest first; a record with no `finishedAt` sorts last, not to the top on a 0.
const done = computed(() => ofStatus(`done`).toSorted((left, right) => (right.finishedAt ?? 0) - (left.finishedAt ?? 0)));

// Everything counting down, across every slice; the top strip must never be hidden by a filter.
const holding = computed(() => approvals.value.filter((item) => item.status === `approved` && imminent(item, now.value)).toSorted(bySoonest));

const isEmpty = computed(() => approvals.value.length === 0 && invalid.value.length === 0 && held.value.length === 0);

// A countdown hold runs itself when the timer passes; the row just says so and keeps cancel in reach. "starting…"
// covers past-due, since the daemon releases on its own coarser tick.
const startsIn = (autoRunAt: number): string => {
    const seconds = Math.ceil((autoRunAt - now.value) / 1_000);
    return seconds <= 0 ? `starting…` : `starts in ${seconds}s unless you cancel`;
};
const wakeName = (wake: AutomationApproval): string => wake.title ?? wake.automationId;

// Release runs the wake now; drop means never. Both report through the same error strip as the rest of the queue.
const releaseWake = (wake: AutomationApproval): Promise<void> =>
    run(async () => {
        await approveWake.mutateAsync(wake.id);
    }, `Could not start the automation.`);
const dropWake = (wake: AutomationApproval): Promise<void> =>
    run(async () => {
        await rejectWake.mutateAsync(wake.id);
    }, `Could not drop the held automation.`);

// Reject destroys a file and Approve-all commits the whole queue; each holds the thing it is asking about.
const rejecting = ref<ApprovalSummary | undefined>(undefined);
const approvingAll = ref(false);

// Approve, retry, put-back and reschedule are all a re-post of the whole item with one field changed (upsert by id).
const patch = <T extends ApprovalSummary>(item: T, changes: Partial<T>): Promise<void> =>
    run(async () => {
        await save.mutateAsync({ ...item, ...changes });
    }, `Could not update it.`);

// One post editable at a time, saved as typed (usePostEdit.ts): a second open field is a second thing to track, and the
// row shouldn't need a Save button.
const edit = usePostEdit(async (post, changes) => void (await save.mutateAsync({ ...post, ...changes })));

// Flushes pending keystrokes before acting, so approving right after a fix doesn't publish the pre-edit text.
const settled = (act: () => Promise<unknown>): Promise<void> =>
    run(async () => {
        await edit.flush();
        await act();
    }, `Could not update it.`);

const approve = (item: ApprovalSummary): Promise<void> => settled(() => save.mutateAsync({ ...item, status: `approved` }));

// Snapshots the list before looping: each approval removes a row from `needsReview`, which would shrink underneath a
// live read.
const approveAll = (): Promise<void> => {
    const queue = needsReview.value;
    approvingAll.value = false;
    return run(async () => {
        await edit.flush();
        for (const item of queue) {
            await save.mutateAsync({ ...item, status: `approved` });
        }
    }, `Could not approve everything.`);
};

const reject = (item: ApprovalSummary): Promise<void> => {
    rejecting.value = undefined;
    return run(async () => {
        await remove.mutateAsync(item.id);
    }, `Could not remove it.`);
};

// Toggles in place: opening makes the words typeable where they are; closing writes the last of them on the way out.
const toggleEdit = (post: PostApprovalSummary): Promise<void> =>
    run(async () => {
        await (edit.isEditing(post) ? edit.close() : edit.open(post));
    }, `Could not save your changes.`);

// Clears `scheduledAt` along with the status: it's a deadline the daemon wrote, and re-approving a held item without
// clearing it would fire instantly, with no second hold to stop it.
const holdBack = (item: ApprovalSummary): Promise<void> => patch(item, { status: `proposed`, scheduledAt: undefined });

const holdBackAll = (): Promise<void> => {
    const queue = holding.value;
    return run(async () => {
        for (const item of queue) {
            await save.mutateAsync({ ...item, status: `proposed`, scheduledAt: undefined });
        }
    }, `Could not hold those back.`);
};

// One line at the top covers the case where the eye has moved on from the row itself. `info`, not `warning`: nothing's
// wrong. A fixed `key` keeps each tick as one notice, not a new one per second.
const goingAheadNotice = computed<NoticeModel | undefined>(() => {
    const soonest = holding.value[0];
    if (!canShip.value || soonest === undefined) {
        return undefined;
    }
    const count = holding.value.length;
    const when = countdownWords((soonest.scheduledAt ?? 0) - now.value);
    const inWhen = when === `any moment now` ? when : `in ${when}`;
    return {
        tone: `info`,
        title: count === 1 ? `"${headline(soonest)}" goes ahead ${inWhen}.` : `${count} things go ahead, the first ${inWhen}.`,
        action: { label: count === 1 ? `Hold it back` : `Hold them back`, run: () => void holdBackAll() },
        key: `approvals-going-ahead`,
    };
});

// One-line name for a confirm list or aria-label: a post's title or opening line; an action's summary.
const headline = (item: ApprovalSummary): string => (isPost(item) ? (item.title ?? item.content.split(`\n`)[0] ?? item.id) : item.summary);

// Post length against the platform's limit: going over doesn't make a worse post, it makes no post.
const OVERSIZED = 280;
// Counts off the live field while editing (usePostEdit.ts), so the number tracks each keystroke instead of a stale
// editor footer.
const lengthOf = (item: ApprovalSummary): string | undefined => {
    if (!isPost(item)) {
        return undefined;
    }
    const limit = limitOf(item.platform);
    const count = edit.liveLength(item);
    if (limit !== undefined) {
        return `${count.toLocaleString()} / ${limit.toLocaleString()}`;
    }
    return count > OVERSIZED || edit.isEditing(item) ? `${count.toLocaleString()} characters` : undefined;
};
const isOver = (item: ApprovalSummary): boolean => isPost(item) && edit.liveLength(item) > (limitOf(item.platform) ?? Infinity);

// The agent's own note on a post, held in `title` wherever the platform doesn't publish one (postText.ts): shown as one
// muted line, not a headline.
const noteOf = (item: ApprovalSummary): string | undefined => (isPost(item) && !postsATitle(item.platform, item.target) ? item.title : undefined);

// A result that is an address is somewhere to go; anything else is a sentence to read.
const resultHref = (item: ApprovalSummary): string | undefined => (item.result?.startsWith(`http`) === true ? item.result : undefined);

// Indent matches the mark plus <Row>'s gap, so the body aligns with the header; only from `sm` up.
const POST_COLUMN = `sm:pl-10`;
const QUIET_COLUMN = `sm:pl-8`;

// An action's mark: brand-mark footprint, wearing the rail's own glyph for actions.
const ACTION_MARK = `flex shrink-0 items-center justify-center rounded-md bg-overlay text-muted`;

// Row footer facts, held to the body's measure so a trailing note truncates against the column.
const FACTS = `mt-3 flex max-w-read flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted`;

// Two lines at most, rest on hover; below the post since it's the agent talking about it, not the post itself.
const NOTE = `mt-1.5 line-clamp-2 max-w-read text-2xs leading-relaxed text-subtle`;

// The pencil lives with the row's other actions, not the footer, so "what can I do here" has one answer in one place.
// It's a toggle that lights up; nothing else on the row moves when it opens.
const EDIT_ACTIVE = `bg-overlay text-content`;
</script>

<template>
    <!-- `scroll="page"`: a queue is a feed, and rows are tall, so a clamped pane hid most of them behind an inner scrollbar. -->
    <SplitView title="Approvals" scroll="page" :scroll-key="railScope">
        <!-- Whole-page banners: the countdown speaks for every slice, and an unparsed file has no slice to belong to. -->
        <template #strips>
            <NoticeStack :of="[actionError, listNotice, heldNotice, goingAheadNotice]" />
            <Notice v-if="invalid.length > 0" tone="warning">
                {{ invalid.length }} file{{ invalid.length === 1 ? "" : "s" }} couldn't be read and won't run:
                <span class="font-mono">{{ invalid.join(", ") }}</span>
            </Notice>
        </template>

        <!--
            The rail narrows rather than selects, so it folds above the queue on a phone instead of covering it. Hidden on an empty queue: a column
            of nothing pointing at nothing.
        -->
        <template v-if="!isEmpty" #rail>
            <ApprovalRail v-model="railScope" :all="allScope" :scopes="scopes" />
        </template>

        <template #detail>
            <div class="flex flex-col">
                <!-- Loading looks like empty otherwise, and the empty-state text would be an unverified claim; skeleton rows stand in instead. -->
                <template v-if="isLoading">
                    <RowGroup v-if="outline" role="status" aria-busy="true">
                        <template #label><span class="skeleton block h-2.5 w-20" aria-hidden="true" /></template>
                        <span class="sr-only">Reading the approvals queue…</span>
                        <SkeletonRows :rows="3" description control />
                    </RowGroup>
                </template>

                <!-- Nothing at all. The rail hides its own tile here, so a reader arriving deliberately is owed an explanation. -->
                <p v-else-if="isEmpty" :class="ui.emptyState(`py-8`)">
                    Nothing waiting. Posts your agent wants to publish, anything else it should not do unasked, and automations set to ask first all
                    land here for you to approve.
                </p>

                <div v-else class="flex flex-col gap-6">
                    <!-- Broken first: the only state where the queue already tried and stopped. -->
                    <RowGroup v-if="failed.length > 0" label="Failed" :count="failed.length">
                        <Row v-for="item in failed" :key="item.id">
                            <template #lead>
                                <BrandMark v-if="isPost(item)" :size="28" :name="nameOf(item)" :logo="logoOfPlatform(item.platform)" />
                                <span v-else :class="ACTION_MARK" class="h-7 w-7 text-sm"><Icon name="bolt" /></span>
                            </template>
                            <template #description><ApprovalMeta :name="nameOf(item)" :target="targetOf(item)" :acts-as="item.actsAs" /></template>
                            <template #control>
                                <!-- A too-long post can only be retried at the length that failed unless it's edited, so the pencil is here too. -->
                                <button
                                    v-if="canShip && isPost(item)"
                                    type="button"
                                    :class="ui.iconButton(`h-8 w-8`, edit.isEditing(item) ? EDIT_ACTIVE : ``)"
                                    :aria-label="`Edit ${headline(item)}`"
                                    :aria-pressed="edit.isEditing(item)"
                                    v-tooltip.top="edit.isEditing(item) ? `Done editing` : `Edit the post`"
                                    v-action="() => toggleEdit(item)"
                                >
                                    <Icon name="pencil" />
                                </button>
                                <button
                                    v-if="canShip"
                                    type="button"
                                    :class="ui.iconButton(`h-8 w-8 hover:bg-danger/10 hover:text-danger`)"
                                    :aria-label="`Reject ${headline(item)}`"
                                    v-tooltip.top="`Reject: deletes it`"
                                    @click="rejecting = item"
                                >
                                    <Icon name="trash" />
                                </button>
                                <Button
                                    v-if="canShip"
                                    label="Retry"
                                    size="small"
                                    severity="secondary"
                                    :disabled="save.isPending.value"
                                    @click="settled(() => save.mutateAsync({ ...item, status: `approved` }))"
                                >
                                    <template #icon><Icon name="refresh" /></template>
                                </Button>
                            </template>
                            <template #below>
                                <div :class="POST_COLUMN">
                                    <template v-if="isPost(item)">
                                        <PostEditor
                                            v-if="edit.isEditing(item)"
                                            :post="item"
                                            v-model:content="edit.content.value"
                                            v-model:title="edit.title.value"
                                            @touch="edit.touch()"
                                            @close="toggleEdit(item)"
                                        />
                                        <PostBody v-else :post="item" />
                                    </template>
                                    <ActionBody v-else :action="item" />
                                    <!--
                                        The failure reason, in the row: the one state whose whole content is an explanation, not hidden behind a
                                        hover.
                                    -->
                                    <Notice :of="noticeOf(item.error ?? `The run did not say why.`)" class="mt-3 max-w-read" />
                                    <div v-if="lengthOf(item)" :class="FACTS">
                                        <span :class="isOver(item) ? `text-danger` : ``">{{ lengthOf(item) }}</span>
                                    </div>
                                    <!-- The agent's own note about the post, under everything it is a note about. -->
                                    <p v-if="noteOf(item)" :class="NOTE" v-tooltip.top="noteOf(item)">{{ noteOf(item) }}</p>
                                </div>
                            </template>
                        </Row>
                    </RowGroup>

                    <RowGroup v-if="needsReview.length > 0" label="Needs your review" :count="needsReview.length">
                        <template v-if="needsReview.length > 1" #actions>
                            <button
                                v-if="canShip"
                                type="button"
                                :class="ui.linkButton()"
                                :disabled="save.isPending.value"
                                @click="approvingAll = true"
                            >
                                Approve all {{ needsReview.length }}
                            </button>
                        </template>
                        <Row v-for="item in needsReview" :key="item.id">
                            <template #lead>
                                <BrandMark v-if="isPost(item)" :size="28" :name="nameOf(item)" :logo="logoOfPlatform(item.platform)" />
                                <span v-else :class="ACTION_MARK" class="h-7 w-7 text-sm"><Icon name="bolt" /></span>
                            </template>
                            <template #description>
                                <ApprovalMeta
                                    :name="nameOf(item)"
                                    :target="targetOf(item)"
                                    :acts-as="item.actsAs"
                                    :note="item.createdAt === undefined ? undefined : `proposed ${timeAgo(item.createdAt)}`"
                                />
                            </template>
                            <!--
                                Edit, reject, approve, in escalating order; none moves or hides when the editor opens. Approving mid-edit is safe:
                                the click flushes pending keystrokes first (`settled`).
                            -->
                            <template #control>
                                <button
                                    v-if="canShip && isPost(item)"
                                    type="button"
                                    :class="ui.iconButton(`h-8 w-8`, edit.isEditing(item) ? EDIT_ACTIVE : ``)"
                                    :aria-label="`Edit ${headline(item)}`"
                                    :aria-pressed="edit.isEditing(item)"
                                    v-tooltip.top="edit.isEditing(item) ? `Done editing` : `Edit the post`"
                                    v-action="() => toggleEdit(item)"
                                >
                                    <Icon name="pencil" />
                                </button>
                                <button
                                    v-if="canShip"
                                    type="button"
                                    :class="ui.iconButton(`h-8 w-8 hover:bg-danger/10 hover:text-danger`)"
                                    :aria-label="`Reject ${headline(item)}`"
                                    v-tooltip.top="`Reject: deletes it`"
                                    @click="rejecting = item"
                                >
                                    <Icon name="trash" />
                                </button>
                                <Button v-if="canShip" label="Approve" size="small" :disabled="save.isPending.value" @click="approve(item)">
                                    <template #icon><Icon name="check" /></template>
                                </Button>
                            </template>
                            <template #below>
                                <div :class="POST_COLUMN">
                                    <!--
                                        The body, or the same post with a caret in it: same column and measure either way, unclamped, since the words
                                        are what the decision is about.
                                    -->
                                    <template v-if="isPost(item)">
                                        <PostEditor
                                            v-if="edit.isEditing(item)"
                                            :post="item"
                                            v-model:content="edit.content.value"
                                            v-model:title="edit.title.value"
                                            @touch="edit.touch()"
                                            @close="toggleEdit(item)"
                                        />
                                        <PostBody v-else :post="item" />
                                    </template>
                                    <ActionBody v-else :action="item" />

                                    <!--
                                        Facts that decide the item, not describe it: when it runs, and whether a post fits. Unmoved by the edit
                                        toggle; the count just follows the keystrokes.
                                    -->
                                    <div :class="FACTS">
                                        <ScheduleControl
                                            :at="item.scheduledAt"
                                            :label="headline(item)"
                                            @change="patch(item, { scheduledAt: $event })"
                                        />
                                        <span v-if="lengthOf(item)" :class="isOver(item) ? `text-danger` : ``">{{ lengthOf(item) }}</span>
                                    </div>
                                    <!-- The agent's own note about the post, under everything it is a note about. -->
                                    <p v-if="noteOf(item)" :class="NOTE" v-tooltip.top="noteOf(item)">{{ noteOf(item) }}</p>
                                </div>
                            </template>
                        </Row>
                    </RowGroup>

                    <!--
                        One section for both hold shapes, since the reader's question is the same: run it, or not? A deadline-less hold waits for a
                        yes; a countdown hold offers start-now or cancel.
                    -->
                    <RowGroup v-if="heldVisible.length > 0" label="Automations held for you" :count="heldVisible.length">
                        <Row v-for="wake in heldVisible" :key="wake.id" :title="wakeName(wake)">
                            <template #lead>
                                <span :class="ACTION_MARK" class="h-7 w-7 text-sm"><Icon name="clock" /></span>
                            </template>
                            <template #description>
                                <span class="block truncate">
                                    <span>automation {{ wake.automationId }}</span>
                                    <span class="text-subtle"> · </span>fired {{ timeAgo(wake.createdAt) }}
                                </span>
                            </template>
                            <template #meta>
                                <span v-if="wake.autoRunAt !== undefined" class="tabular-nums text-warning">{{ startsIn(wake.autoRunAt) }}</span>
                            </template>
                            <template #control>
                                <Button
                                    v-if="canShip"
                                    :label="wake.autoRunAt !== undefined ? `Cancel` : `Reject`"
                                    size="small"
                                    severity="secondary"
                                    :text="true"
                                    :disabled="rejectWake.isPending.value"
                                    :aria-label="`${wake.autoRunAt !== undefined ? `Cancel` : `Reject`} ${wakeName(wake)}`"
                                    @click="dropWake(wake)"
                                />
                                <Button
                                    v-if="canShip"
                                    :label="wake.autoRunAt !== undefined ? `Start now` : `Approve`"
                                    size="small"
                                    :disabled="approveWake.isPending.value"
                                    :aria-label="`${wake.autoRunAt !== undefined ? `Start` : `Approve`} ${wakeName(wake)}`"
                                    @click="releaseWake(wake)"
                                >
                                    <template #icon><Icon name="check" /></template>
                                </Button>
                            </template>
                            <template v-if="wake.payload" #below>
                                <div :class="POST_COLUMN">
                                    <code class="block max-w-read truncate font-mono text-2xs text-subtle" v-tooltip.top="wake.payload">{{
                                        wake.payload
                                    }}</code>
                                </div>
                            </template>
                        </Row>
                    </RowGroup>

                    <!--
                        Sits right under the review queue since that's where an approved row lands, reading as one step along rather than a page
                        rearrange. One labelled Stop button, unlike its quiet neighbors: urgent and singular.
                    -->
                    <RowGroup v-if="goingAhead.length > 0" label="Going ahead" :count="goingAhead.length">
                        <Row v-for="item in goingAhead" :key="item.id" density="compact">
                            <template #lead>
                                <BrandMark v-if="isPost(item)" :size="22" :name="nameOf(item)" :logo="logoOfPlatform(item.platform)" />
                                <span v-else :class="ACTION_MARK" class="h-6 w-6 text-xs"><Icon name="bolt" /></span>
                            </template>
                            <template #description><ApprovalMeta :name="nameOf(item)" :target="targetOf(item)" :acts-as="item.actsAs" /></template>
                            <template #meta>
                                <!-- Mid-run: nothing left to stop, so the row says so instead of offering a button that would lose the race. -->
                                <StatusBadge v-if="item.status === `running`" variant="info" label="in progress" size="xs" :dot="true" />
                                <span v-else class="tabular-nums text-warning">{{ countdownWords((item.scheduledAt ?? 0) - now) }}</span>
                            </template>
                            <template v-if="item.status === `approved`" #control>
                                <Button
                                    v-if="canShip"
                                    label="Stop"
                                    size="small"
                                    severity="secondary"
                                    :disabled="save.isPending.value"
                                    :aria-label="`Stop ${headline(item)} and put it back in review`"
                                    v-tooltip.top="`Back to review: nothing happens`"
                                    @click="holdBack(item)"
                                >
                                    <template #icon><Icon name="undo" /></template>
                                </Button>
                            </template>
                            <template #below>
                                <div :class="QUIET_COLUMN">
                                    <PostBody v-if="isPost(item)" :post="item" tone="quiet" />
                                    <ActionBody v-else :action="item" tone="quiet" />
                                </div>
                            </template>
                        </Row>
                    </RowGroup>

                    <!-- Approved with time to spare; quiet by design, since the decision is made and the row need only say when. -->
                    <RowGroup v-if="scheduled.length > 0" label="Scheduled" :count="scheduled.length">
                        <Row v-for="item in scheduled" :key="item.id" density="compact">
                            <template #lead>
                                <BrandMark v-if="isPost(item)" :size="22" :name="nameOf(item)" :logo="logoOfPlatform(item.platform)" />
                                <span v-else :class="ACTION_MARK" class="h-6 w-6 text-xs"><Icon name="bolt" /></span>
                            </template>
                            <template #description><ApprovalMeta :name="nameOf(item)" :target="targetOf(item)" :acts-as="item.actsAs" /></template>
                            <template #control>
                                <div v-if="canShip" class="text-2xs text-subtle">
                                    <ScheduleControl :at="item.scheduledAt" :label="headline(item)" @change="patch(item, { scheduledAt: $event })" />
                                </div>
                                <button
                                    v-if="canShip"
                                    type="button"
                                    :class="ui.iconButton()"
                                    :aria-label="`Put ${headline(item)} back in review`"
                                    v-tooltip.top="`Put back in review`"
                                    v-action="() => holdBack(item)"
                                >
                                    <Icon name="undo" />
                                </button>
                                <button
                                    v-if="canShip"
                                    type="button"
                                    :class="ui.iconButton(`hover:bg-danger/10 hover:text-danger`)"
                                    :aria-label="`Reject ${headline(item)}`"
                                    v-tooltip.top="`Reject: deletes it`"
                                    @click="rejecting = item"
                                >
                                    <Icon name="trash" />
                                </button>
                            </template>
                            <template #below>
                                <div :class="QUIET_COLUMN">
                                    <PostBody v-if="isPost(item)" :post="item" tone="quiet" />
                                    <ActionBody v-else :action="item" tone="quiet" />
                                </div>
                            </template>
                        </Row>
                    </RowGroup>

                    <!-- History: nothing here can be acted on, so the row shows only what happened, where, when, and its result. -->
                    <RowGroup v-if="done.length > 0" label="Done" :count="done.length">
                        <Row v-for="item in done" :key="item.id" density="compact">
                            <template #lead>
                                <BrandMark v-if="isPost(item)" :size="22" :name="nameOf(item)" :logo="logoOfPlatform(item.platform)" :idle="true" />
                                <span v-else :class="ACTION_MARK" class="h-6 w-6 text-xs opacity-60"><Icon name="bolt" /></span>
                            </template>
                            <template #description><ApprovalMeta :name="nameOf(item)" :target="targetOf(item)" :acts-as="item.actsAs" /></template>
                            <template #meta>
                                <a
                                    v-if="resultHref(item)"
                                    :href="resultHref(item)"
                                    target="_blank"
                                    rel="noopener"
                                    class="text-link hover:underline"
                                    v-tooltip.top="item.result"
                                >
                                    Open<Icon name="external-link" class="ml-1 text-2xs" />
                                </a>
                                <span v-else-if="item.result" class="truncate text-subtle" v-tooltip.top="item.result">{{ item.result }}</span>
                                <span v-if="item.finishedAt !== undefined" v-tooltip.top="formatTimestamp(item.finishedAt)">{{
                                    timeAgo(item.finishedAt)
                                }}</span>
                            </template>
                            <template #control>
                                <button
                                    v-if="canShip"
                                    type="button"
                                    :class="ui.iconButton()"
                                    :aria-label="`Remove ${headline(item)} from the list`"
                                    v-tooltip.top="`Remove from this list: what was done stays done`"
                                    @click="rejecting = item"
                                >
                                    <Icon name="times" />
                                </button>
                            </template>
                            <template #below>
                                <div :class="QUIET_COLUMN">
                                    <PostBody v-if="isPost(item)" :post="item" tone="quiet" />
                                    <ActionBody v-else :action="item" tone="quiet" />
                                </div>
                            </template>
                        </Row>
                    </RowGroup>
                </div>

                <!-- Rejecting deletes the file outright, no undo; a done row's version of this asks about the record only, and says so. -->
                <ConfirmDialog
                    :open="rejecting !== undefined"
                    :header="rejecting?.status === `done` ? `Remove this record?` : `Reject this?`"
                    :confirm-label="rejecting?.status === `done` ? `Remove` : `Reject`"
                    confirm-icon="trash"
                    :loading="remove.isPending.value"
                    @cancel="rejecting = undefined"
                    @confirm="rejecting && reject(rejecting)"
                >
                    <p v-if="rejecting" class="text-sm text-muted">
                        <template v-if="rejecting.status === `done`">
                            <template v-if="isPost(rejecting)"
                                >The post stays up on {{ nameOf(rejecting) }}: only this record of it is deleted.</template
                            >
                            <template v-else>What was done stays done: only this record of it is deleted.</template>
                        </template>
                        <template v-else>The file is deleted. Your agent would have to propose it again.</template>
                    </p>
                </ConfirmDialog>

                <ConfirmDialog
                    :open="approvingAll"
                    header="Approve everything waiting?"
                    :confirm-label="`Approve ${needsReview.length}`"
                    confirm-icon="check"
                    :destructive="false"
                    :items="needsReview"
                    :loading="save.isPending.value"
                    @cancel="approvingAll = false"
                    @confirm="approveAll"
                >
                    <template #item="{ item }">
                        <BrandMark v-if="isPost(item)" :size="20" :name="nameOf(item)" :logo="logoOfPlatform(item.platform)" />
                        <span v-else :class="ACTION_MARK" class="h-5 w-5 text-xs"><Icon name="bolt" /></span>
                        <span class="truncate">{{ headline(item) }}</span>
                    </template>
                    <p class="mt-2 text-sm text-muted">Each goes ahead on its own date, or after a short countdown if it has none.</p>
                </ConfirmDialog>
            </div>
        </template>
    </SplitView>
</template>
