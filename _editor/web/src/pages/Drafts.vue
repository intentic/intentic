<script setup lang="ts">
import type { DraftSummary } from "@intentic-app/api-contract";
import {
    BrandMark,
    cmp,
    ConfirmDialog,
    formatTimestamp,
    InfoHint,
    type NoticeModel,
    NoticeStack,
    Page,
    PageHeader,
    Row,
    RowGroup,
    StatusBadge,
    timeAgo,
} from "@intentic/ui";
import Button from "primevue/button";
import { computed, ref } from "vue";
import { useRole } from "../composables/sandbox/useRole";
import { useAsyncAction } from "../composables/useAsyncAction";
import { useDrafts } from "../composables/extensions/useDrafts";
import { useExtensions } from "../composables/extensions/useExtensions";
import DraftMeta from "./drafts/DraftMeta.vue";
import DraftPost from "./drafts/DraftPost.vue";
import { limitOf, postsATitle } from "./drafts/postText";
import ScheduleControl from "./drafts/ScheduleControl.vue";

/* Drafts: the approval inbox for posts the agent proposed during its scheduled work. The agent writes one JSON
 * file per draft into .intentic/drafts/ (taught by the daemon's drafts skill); this page is the owner's
 * approve / reschedule / reject side. Approving fires the "Publish approved drafts" automation immediately
 * (the daemon's drafts routes own that moment); a draft approved for a future scheduledAt is picked up by the
 * same automation's sweep when its time comes. There is no create dialog here — drafts originate with the
 * agent, never the UI.
 *
 * THE POST IS THE SUBJECT OF THE ROW, and it is READ rather than glanced at. Everything about where a draft is
 * going lives on one muted line beneath a brand mark; under it the post is set as a post — a capped measure,
 * body type, paragraph rhythm (DraftPost.vue) — because a row as wide as the window runs ~110 characters to
 * the line, and past about 75 the eye loses the start of the next one. That is what made the queue unreadable
 * even after the chips came off it: nothing on screen was competing with the text any more, but the text was
 * still typeset like a log line.
 *
 * THE ROW IS ONE COLUMN. The mark hangs in a gutter and the platform line, the post and the facts under it all
 * start at the same left edge, the way every surface anyone reads posts on composes one.
 *
 * ONE FOOTER, THREE FACTS, and they are the ones that DECIDE the post rather than describe it: when it goes,
 * whether it fits where it is going, and what the agent said it was for. The length against the platform's cap
 * is the one property of a draft that reading it cannot tell you and that kills the post outright when it is
 * wrong, so it is stated rather than left to be counted.
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
// The list query knows it failed and nothing else; this page knows what the user came for.
const listNotice = computed<NoticeModel | undefined>(() =>
    listError.value === undefined ? undefined : { tone: `danger`, title: `Couldn't read your drafts.`, detail: listError.value },
);
// Publishing is the ship tier: below maintainer the queue is a read — the posts, their schedule, their
// status — with every approve/reject/reschedule affordance absent (the daemon floors the draft mutations
// the same way). Watching what is about to go out is exactly what a viewer is for.
const { canShip } = useRole();
const { enabled: enabledExtensions } = useExtensions();
const { notice: actionError, run } = useAsyncAction();

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

/* HOW BIG THE POST IS, against the room the platform gives it. The one property of a draft that decides whether
 * it can post at all and that reading it cannot tell you — 30 characters over on X is not a worse post, it is
 * no post — so it sits in the footer of every row that still owes a decision, and turns red when it is the
 * reason the draft will fail. Platforms with no well-known cap (postText.ts) get a plain count, and only once
 * the post is long enough for its size to be a question at all. */
const OVERSIZED = 280;
const lengthOf = (draft: DraftSummary): string | undefined => {
    const limit = limitOf(draft.platform);
    const count = draft.content.length;
    if (limit !== undefined) {
        return `${count.toLocaleString()} / ${limit.toLocaleString()}`;
    }
    return count > OVERSIZED ? `${count.toLocaleString()} characters` : undefined;
};
const isOver = (draft: DraftSummary): boolean => draft.content.length > (limitOf(draft.platform) ?? Infinity);

/* THE AGENT'S OWN NOTE about the draft, which is what `title` holds everywhere the platform doesn't publish one
 * (postText.ts): why this post, which thread, what it is not saying. Worth keeping — it is the reasoning behind
 * the thing being approved — and worth keeping SMALL: rendered as a headline it was a three-line bold block
 * above a post it had no business outweighing. One muted line, the rest on hover. */
const noteOf = (draft: DraftSummary): string | undefined => (postsATitle(draft.platform, draft.target) ? undefined : draft.title);

/* ONE COLUMN PER ROW. The brand mark sits in a gutter and everything else — the platform line, the post, the
 * facts under it — starts at the same left edge, the way every surface that shows a post composes one. The
 * indent is the mark plus <Row>'s own gap (28 + 10, and 22 + 10 on the compact tiers), so it tracks the header
 * beside it rather than being a number that happens to look right today. Only from `sm` up: on a phone those
 * 38px are a tenth of the line, and an aligned column costs more than a hanging one is worth. */
const POST_COLUMN = `sm:pl-[2.375rem]`;
const QUIET_COLUMN = `sm:pl-8`;

// The row's footer: facts about the post, wrapping on a narrow screen, quieter than the post itself, and held
// to the post's own measure so the note at its end truncates against the column rather than the window.
const FACTS = `mt-3 flex max-w-[64ch] flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted`;

// And the note under it: two lines at most, the rest on hover. Below the post rather than above it, because it
// is the agent talking ABOUT the post — a reader who mistakes it for the post has read the wrong thing.
const NOTE = `mt-1.5 line-clamp-2 max-w-[64ch] text-2xs leading-relaxed text-subtle`;
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

        <NoticeStack :of="[actionError, listNotice]" class="mb-4" />
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
                        <div :class="POST_COLUMN">
                            <DraftPost :draft="draft" />
                            <!-- The reason, in the row. It used to live in a tooltip on the status badge — the
                                 one state whose entire content is an explanation, hidden behind a hover. -->
                            <p :class="cmp.alertDanger(`mt-3 max-w-[64ch]`)">{{ draft.error ?? `The publisher did not say why.` }}</p>
                            <div :class="FACTS">
                                <span v-if="lengthOf(draft)" :class="isOver(draft) ? `text-danger` : ``">{{ lengthOf(draft) }}</span>
                            </div>
                            <!-- The agent's own note about the draft, under everything it is a note about. -->
                            <p v-if="noteOf(draft)" :class="NOTE" v-tooltip.top="noteOf(draft)">{{ noteOf(draft) }}</p>
                        </div>
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
                        <div :class="POST_COLUMN">
                            <!-- Unclamped up to a screenful, deliberately: this is the section where a decision
                                 is owed, and the post's own words are what the decision is about. -->
                            <DraftPost :draft="draft" />

                            <!-- The three facts that DECIDE the post rather than describe it: when it goes,
                                 whether it fits where it is going, and what the agent said it was for. -->
                            <div :class="FACTS">
                                <ScheduleControl :at="draft.scheduledAt" :label="headline(draft)" @change="patch(draft, { scheduledAt: $event })" />
                                <span v-if="lengthOf(draft)" :class="isOver(draft) ? `text-danger` : ``">{{ lengthOf(draft) }}</span>
                            </div>
                            <!-- The agent's own note about the draft, under everything it is a note about. -->
                            <p v-if="noteOf(draft)" :class="NOTE" v-tooltip.top="noteOf(draft)">{{ noteOf(draft) }}</p>
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
                        <div :class="QUIET_COLUMN"><DraftPost :draft="draft" tone="quiet" /></div>
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
                        <div :class="QUIET_COLUMN"><DraftPost :draft="draft" tone="quiet" /></div>
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
