<script setup lang="ts">
import type { DraftSummary } from "@intentic-app/api-contract";
import { BrandMark, cmp, ConfirmDialog, formatTimestamp, InfoHint, Page, PageHeader, Row, RowGroup, StatusBadge, timeAgo } from "@intentic/ui";
import Button from "primevue/button";
import { computed, ref } from "vue";
import { useRole } from "../composables/sandbox/useRole";
import { attachmentPreview } from "../composables/chat/attachmentPreviews";
import { useAsyncAction } from "../composables/useAsyncAction";
import { useDrafts } from "../composables/extensions/useDrafts";
import { useExtensions } from "../composables/extensions/useExtensions";
import DraftMeta from "./drafts/DraftMeta.vue";
import ScheduleControl from "./drafts/ScheduleControl.vue";

/* Drafts: the approval inbox for posts the agent proposed during its scheduled work. The agent writes one JSON
 * file per draft into .intentic/drafts/ (taught by the daemon's drafts skill); this page is the owner's
 * approve / reschedule / reject side. Approving fires the "Publish approved drafts" automation immediately
 * (the daemon's drafts routes own that moment); a draft approved for a future scheduledAt is picked up by the
 * same automation's sweep when its time comes. There is no create dialog here — drafts originate with the
 * agent, never the UI.
 *
 * THE POST IS THE SUBJECT OF THE ROW. This page had it the other way round: the platform, the target and the
 * status were three filled chips across the header line and the text being approved was the smallest, faintest
 * thing on the screen, clamped to three lines — the longest draft rendered its third line as a bare "…". You
 * cannot approve what you cannot read. The post body now carries the row's own type size, unclamped in the
 * sections where a decision is owed, and everything about WHERE it is going has been demoted to one muted line
 * beneath a brand mark. That single inversion is what removed most of the boxes the page was made of: a logo
 * and a line of plain text say what four tinted pills were saying.
 *
 * ONE SECTION PER DECISION, in the order the queue owes them: something broke, something is waiting on you,
 * something is on its way, something already went out. A status badge survives only where its section does not
 * already state it (`posting`, inside Scheduled) — every other badge was re-labelling its own group. The
 * sections also settle an ordering the flat list never had: the daemon's store is a directory of files, so
 * rows arrived in filesystem order. Each section sorts by the field it is actually read for — soonest first
 * while something can still be changed, newest first once it is history.
 *
 * WEIGHT MARKS PRIORITY. Only the section that owes a decision carries labelled buttons; scheduled and posted
 * rows get bare icon actions and a smaller mark. A queue with nothing to review should look like nothing to
 * do. */

const { drafts, invalid, error: listError, save, remove } = useDrafts();
// Publishing is the ship tier: below maintainer the queue is a read — the posts, their schedule, their
// status — with every approve/reject/reschedule affordance absent (the daemon floors the draft mutations
// the same way). Watching what is about to go out is exactly what a viewer is for.
const { canShip } = useRole();
const { enabled: enabledExtensions } = useExtensions();
const { error: actionError, run } = useAsyncAction();

/* WHO POSTS IT, from the manifest that owns that fact. `platform` is a bare string by contract (a new platform
 * needs no contract change) and it is the id of the capability whose skill does the posting — so the enabled
 * extensions' own catalog entries already hold its display name and brand slug, including the detail nothing
 * here could have guessed: X's mark is black, so its entry forces a light one. A platform with no installed
 * connector still renders, because BrandMark falls through to a monogram, and that is the case that has to
 * keep working: a draft can be proposed for somewhere this sandbox cannot yet post. */
const platformCatalog = computed(
    () =>
        new Map(
            enabledExtensions.value
                .flatMap((extension) => extension.manifest.contributes?.capabilities ?? [])
                .map((contribution) => [contribution.id, contribution.catalog] as const),
        ),
);
const platformName = (draft: DraftSummary): string => platformCatalog.value.get(draft.platform)?.name ?? draft.platform;
const platformLogo = (draft: DraftSummary): string | undefined => platformCatalog.value.get(draft.platform)?.logo;

// Soonest first, undated last — the queue then reads in the order it will actually go out. A draft with no
// date does post as soon as it is picked up, but it is also the one still owed a decision about when, so it
// belongs at the end of the run rather than jumping the front of it.
const due = (draft: DraftSummary): number => draft.scheduledAt ?? Number.MAX_SAFE_INTEGER;
const bySoonest = (left: DraftSummary, right: DraftSummary): number => due(left) - due(right);

const ofStatus = (...statuses: DraftSummary[`status`][]): DraftSummary[] => drafts.value.filter((draft) => statuses.includes(draft.status));

const failed = computed(() => ofStatus(`failed`).toSorted(bySoonest));
const needsReview = computed(() => ofStatus(`proposed`).toSorted(bySoonest));
const scheduled = computed(() => ofStatus(`approved`, `posting`).toSorted(bySoonest));
// History, newest first. postedAt is optional in the contract, so a record without one sorts last rather than
// leaping to the top on a 0.
const posted = computed(() => ofStatus(`posted`).toSorted((left, right) => (right.postedAt ?? 0) - (left.postedAt ?? 0)));

const isEmpty = computed(() => drafts.value.length === 0 && invalid.value.length === 0);

// Reject destroys a file and Approve-all commits the whole queue; each holds the thing it is asking about.
const rejecting = ref<DraftSummary | undefined>(undefined);
const approvingAll = ref(false);

// Approve, retry, put-back and reschedule are all a re-post of the whole file with one field changed (the
// daemon upserts by id). Errors surface in the strip at the top; the query refetch reconciles the row.
const patch = (draft: DraftSummary, changes: Partial<DraftSummary>): Promise<void> =>
    run(async () => {
        await save.mutateAsync({ ...draft, ...changes });
    }, `Could not update the draft.`);

// The list it was fired against, not the live one: each approval moves a row out of `needsReview`, so reading
// the computed inside the loop would walk a list shrinking underneath it.
const approveAll = (): Promise<void> => {
    const queue = needsReview.value;
    approvingAll.value = false;
    return run(async () => {
        for (const draft of queue) {
            await save.mutateAsync({ ...draft, status: `approved` });
        }
    }, `Could not approve every draft.`);
};

const rejectDraft = (draft: DraftSummary): Promise<void> => {
    rejecting.value = undefined;
    return run(async () => {
        await remove.mutateAsync(draft.id);
    }, `Could not remove the draft.`);
};

// What a draft is called where it has to be named in one line — a confirm's list, an action's accessible name.
// The title if the platform wanted one, else the post's opening line.
const headline = (draft: DraftSummary): string => draft.title ?? draft.content.split(`\n`)[0] ?? draft.id;

// The file name alone: a media chip has room for `chart.png`, not for `.intentic/drafts/media/chart.png`.
const fileName = (path: string): string => path.split(`/`).at(-1) ?? path;
</script>

<template>
    <Page>
        <PageHeader title="Drafts" description="Posts your agent prepared for you to approve.">
            <template #info>
                <InfoHint label="How drafts are published">
                    <span class="block text-xs font-semibold text-content">From proposal to post</span>
                    <span class="mt-2 block text-xs text-muted">
                        Your agent writes drafts while it works and never posts one by itself. Approve one and it posts right away through that
                        platform's connector — or, if you gave it a date, when that date comes up. Rejecting deletes the draft file.
                    </span>
                </InfoHint>
            </template>
        </PageHeader>

        <div v-if="actionError ?? listError" :class="cmp.alertDanger(`mb-4`)">
            {{ actionError ?? listError }}
        </div>
        <div v-if="invalid.length > 0" :class="cmp.alertWarning(`mb-4`)">
            <Icon name="exclamation-triangle" class="mr-1.5" />{{ invalid.length }} draft file{{ invalid.length === 1 ? "" : "s" }} couldn't be read
            and won't post: <span class="font-mono">{{ invalid.join(", ") }}</span>
        </div>

        <!-- Nothing proposed, nothing sent, nothing broken. The rail hides its tile in this state, so the page
             is only reached deliberately — and it owes an explanation of what would ever put something here. -->
        <p v-if="isEmpty" :class="cmp.emptyState(`py-8`)">
            No drafts waiting. Posts your agent proposes land here for you to approve before anything is published.
        </p>

        <div v-else class="flex flex-col gap-6">
            <!-- Broken first: the only state where the queue already tried and stopped. -->
            <RowGroup v-if="failed.length > 0" label="Failed to post" :count="failed.length">
                <Row v-for="draft in failed" :key="draft.id">
                    <template #lead><BrandMark :size="28" :name="platformName(draft)" :logo="platformLogo(draft)" /></template>
                    <template #description><DraftMeta :name="platformName(draft)" :target="draft.target" /></template>
                    <template #control>
                        <Button
                            v-if="canShip"
                            label="Retry"
                            size="small"
                            severity="secondary"
                            :disabled="save.isPending.value"
                            @click="patch(draft, { status: `approved` })"
                        >
                            <template #icon><Icon name="refresh" /></template>
                        </Button>
                        <button
                            v-if="canShip"
                            type="button"
                            :class="cmp.iconButton(`h-8 w-8 hover:bg-danger/10 hover:text-danger`)"
                            :aria-label="`Reject ${headline(draft)}`"
                            v-tooltip.top="`Reject — deletes the draft`"
                            @click="rejecting = draft"
                        >
                            <Icon name="trash" />
                        </button>
                    </template>
                    <template #below>
                        <p v-if="draft.title" class="text-sm font-semibold text-content">{{ draft.title }}</p>
                        <p class="whitespace-pre-wrap wrap-break-word text-sm text-content" :class="draft.title ? `mt-1` : ``">{{ draft.content }}</p>
                        <!-- The reason, in the row. It used to live in a tooltip on the status badge — the one
                             state whose entire content is an explanation, hidden behind a hover. -->
                        <p :class="cmp.alertDanger(`mt-3`)">{{ draft.error ?? `The publisher did not say why.` }}</p>
                    </template>
                </Row>
            </RowGroup>

            <RowGroup v-if="needsReview.length > 0" label="Needs your review" :count="needsReview.length">
                <template v-if="needsReview.length > 1" #actions>
                    <button v-if="canShip" type="button" :class="cmp.linkButton()" :disabled="save.isPending.value" @click="approvingAll = true">
                        Approve all {{ needsReview.length }}
                    </button>
                </template>
                <Row v-for="draft in needsReview" :key="draft.id">
                    <template #lead><BrandMark :size="28" :name="platformName(draft)" :logo="platformLogo(draft)" /></template>
                    <template #description>
                        <DraftMeta
                            :name="platformName(draft)"
                            :target="draft.target"
                            :note="draft.createdAt === undefined ? undefined : `proposed ${timeAgo(draft.createdAt)}`"
                        />
                    </template>
                    <template #control>
                        <button
                            v-if="canShip"
                            type="button"
                            :class="cmp.iconButton(`h-8 w-8 hover:bg-danger/10 hover:text-danger`)"
                            :aria-label="`Reject ${headline(draft)}`"
                            v-tooltip.top="`Reject — deletes the draft`"
                            @click="rejecting = draft"
                        >
                            <Icon name="trash" />
                        </button>
                        <Button
                            v-if="canShip"
                            label="Approve"
                            size="small"
                            :disabled="save.isPending.value"
                            @click="patch(draft, { status: `approved` })"
                        >
                            <template #icon><Icon name="check" /></template>
                        </Button>
                    </template>
                    <template #below>
                        <p v-if="draft.title" class="text-sm font-semibold text-content">{{ draft.title }}</p>
                        <!-- Unclamped, deliberately: this is the section where a decision is owed, and the
                             post's own words are what the decision is about. -->
                        <p class="whitespace-pre-wrap wrap-break-word text-sm text-content" :class="draft.title ? `mt-1` : ``">{{ draft.content }}</p>

                        <!-- What goes out WITH the words. An image attached by mistake cannot be repaired by
                             re-reading the caption, so attachments are shown rather than counted. -->
                        <div v-if="draft.media && draft.media.length > 0" class="mt-3 flex flex-wrap items-center gap-2">
                            <template v-for="path in draft.media" :key="path">
                                <img
                                    v-if="attachmentPreview(path)"
                                    :src="attachmentPreview(path)"
                                    :alt="fileName(path)"
                                    class="h-16 w-16 rounded-md border border-line object-cover"
                                    v-tooltip.top="path"
                                />
                                <span
                                    v-else
                                    class="flex items-center gap-1.5 rounded-md border border-line px-2 py-1 text-2xs text-muted"
                                    v-tooltip.top="path"
                                >
                                    <Icon name="paperclip" />{{ fileName(path) }}
                                </span>
                            </template>
                        </div>

                        <div class="mt-3 text-xs text-muted">
                            <ScheduleControl :at="draft.scheduledAt" :label="headline(draft)" @change="patch(draft, { scheduledAt: $event })" />
                        </div>
                    </template>
                </Row>
            </RowGroup>

            <!-- Approved and on its way. Quiet by design: the decision is made, so the row's job is to say when
                 it goes and otherwise stay out of the way of the section above it. -->
            <RowGroup v-if="scheduled.length > 0" label="Scheduled" :count="scheduled.length">
                <Row v-for="draft in scheduled" :key="draft.id" density="compact">
                    <template #lead><BrandMark :size="22" :name="platformName(draft)" :logo="platformLogo(draft)" /></template>
                    <template #description><DraftMeta :name="platformName(draft)" :target="draft.target" /></template>
                    <!-- Handed to the publisher: nothing here can change it any more, so the row states that
                         instead of offering controls that would race the post going out. -->
                    <template #meta>
                        <StatusBadge v-if="draft.status === `posting`" variant="info" label="posting" size="xs" :dot="true" />
                    </template>
                    <template v-if="draft.status === `approved`" #control>
                        <div v-if="canShip" class="text-2xs text-subtle">
                            <ScheduleControl :at="draft.scheduledAt" :label="headline(draft)" @change="patch(draft, { scheduledAt: $event })" />
                        </div>
                        <button
                            v-if="canShip"
                            type="button"
                            :class="cmp.iconButton()"
                            :aria-label="`Put ${headline(draft)} back in review`"
                            v-tooltip.top="`Put back in review`"
                            @click="patch(draft, { status: `proposed` })"
                        >
                            <Icon name="undo" />
                        </button>
                        <button
                            v-if="canShip"
                            type="button"
                            :class="cmp.iconButton(`hover:bg-danger/10 hover:text-danger`)"
                            :aria-label="`Reject ${headline(draft)}`"
                            v-tooltip.top="`Reject — deletes the draft`"
                            @click="rejecting = draft"
                        >
                            <Icon name="trash" />
                        </button>
                    </template>
                    <template #below>
                        <p class="line-clamp-2 whitespace-pre-wrap wrap-break-word text-xs text-muted">{{ draft.content }}</p>
                    </template>
                </Row>
            </RowGroup>

            <!-- History. Nothing here can be acted on any more, so it carries no schedule and no approval —
                 only what went out, where, and when. -->
            <RowGroup v-if="posted.length > 0" label="Posted" :count="posted.length">
                <Row v-for="draft in posted" :key="draft.id" density="compact">
                    <template #lead><BrandMark :size="22" :name="platformName(draft)" :logo="platformLogo(draft)" :idle="true" /></template>
                    <template #description><DraftMeta :name="platformName(draft)" :target="draft.target" /></template>
                    <template #meta>
                        <span v-if="draft.postedAt !== undefined" v-tooltip.top="formatTimestamp(draft.postedAt)">{{ timeAgo(draft.postedAt) }}</span>
                    </template>
                    <template #control>
                        <button
                            v-if="canShip"
                            type="button"
                            :class="cmp.iconButton()"
                            :aria-label="`Remove ${headline(draft)} from the list`"
                            v-tooltip.top="`Remove from this list — the post itself stays up`"
                            @click="rejecting = draft"
                        >
                            <Icon name="times" />
                        </button>
                    </template>
                    <template #below>
                        <p class="line-clamp-2 whitespace-pre-wrap wrap-break-word text-xs text-subtle">{{ draft.content }}</p>
                    </template>
                </Row>
            </RowGroup>
        </div>

        <!-- Rejecting deletes the file: there is no undo and no trash to fish it back out of, which is exactly
             what this dialog is for. A posted draft's row asks the same question about a different thing, and
             says so — deleting the record does not take the post down. -->
        <ConfirmDialog
            :open="rejecting !== undefined"
            :header="rejecting?.status === `posted` ? `Remove this record?` : `Reject this draft?`"
            :confirm-label="rejecting?.status === `posted` ? `Remove` : `Reject`"
            confirm-icon="trash"
            :loading="remove.isPending.value"
            @cancel="rejecting = undefined"
            @confirm="rejecting && rejectDraft(rejecting)"
        >
            <p v-if="rejecting" class="text-sm text-muted">
                <template v-if="rejecting.status === `posted`">
                    The post stays up on {{ platformName(rejecting) }} — only this record of it is deleted.
                </template>
                <template v-else>The draft file is deleted. Your agent would have to propose it again.</template>
            </p>
        </ConfirmDialog>

        <ConfirmDialog
            :open="approvingAll"
            header="Approve every draft?"
            :confirm-label="`Approve ${needsReview.length}`"
            confirm-icon="check"
            :destructive="false"
            :items="needsReview"
            :loading="save.isPending.value"
            @cancel="approvingAll = false"
            @confirm="approveAll"
        >
            <template #item="{ item }">
                <BrandMark :size="20" :name="platformName(item)" :logo="platformLogo(item)" />
                <span class="truncate">{{ headline(item) }}</span>
            </template>
            <p class="mt-2 text-sm text-muted">Each posts on its own date, or as soon as it is picked up if it has none.</p>
        </ConfirmDialog>
    </Page>
</template>
