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
    Row,
    RowGroup,
    SplitView,
    StatusBadge,
    timeAgo,
} from "@intentic/ui";
import Button from "primevue/button";
import { computed, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useRole } from "../composables/sandbox/useRole";
import { useAsyncAction } from "../composables/useAsyncAction";
import { useDrafts } from "../composables/extensions/useDrafts";
import { useExtensions } from "../composables/extensions/useExtensions";
import DraftMeta from "./drafts/DraftMeta.vue";
import DraftPost from "./drafts/DraftPost.vue";
import DraftRail, { type DraftScope } from "./drafts/DraftRail.vue";
import { countdownWords, limitOf, postsATitle } from "./drafts/postText";
import PostEditor from "./drafts/PostEditor.vue";
import ScheduleControl from "./drafts/ScheduleControl.vue";
import { useDraftEdit } from "./drafts/useDraftEdit";
import { useNow } from "../composables/useNow";

/* Drafts: the approval inbox for posts the agent proposed during its scheduled work. The agent writes one JSON
 * file per draft into .intentic/drafts/ (taught by the daemon's drafts skill); this page is the owner's
 * approve / edit / reschedule / reject side. There is no create dialog here — drafts originate with the agent,
 * never the UI.
 *
 * AN INDEX BESIDE THE QUEUE (<SplitView>), the shape Capabilities, Pipelines and the hubs already use, and the
 * app's standard page width with it. It was a narrow column with every section stacked down one scroll — fine
 * for a handful of posts on one platform, and the thing that stops scaling the moment an agent drafts for
 * several: what is waiting on you for one platform sits below everything the others have ever posted. The rail
 * is bounded by how many platforms a workspace posts to, so the body stays finite as the queue behind it grows
 * (see <DraftRail>). It NARROWS rather than selects — every section reads the same whether you came in via All
 * drafts or via one platform — and the slice lives in the URL, so "the Reddit queue" is a link.
 *
 * APPROVING DOES NOT SEND IT. It starts a minute (publish-drafts.ts): the daemon dates the draft one hold into
 * the future and sleeps until exactly then, and for that minute the post sits in Going out with a live count
 * and one button that calls it back. A post is public and permanent the instant it lands, and the gap between
 * realising and reaching for the mouse is about two seconds — so the whole design of this page's second half is
 * that the seconds exist and are visible. A draft carrying a date of its own keeps it and simply waits.
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
 * something is seconds from being public, something is on the calendar, something already went out. A status
 * badge survives only where its section does not already state it (`sending`, inside Going out) — every other
 * badge was re-labelling its own group. The sections also settle an ordering the flat list never had: the
 * daemon's store is a directory of files, so rows arrived in filesystem order. Each section sorts by the field
 * it is actually read for — soonest first while something can still be changed, newest first once it is
 * history.
 *
 * WEIGHT MARKS PRIORITY. Only the section that owes a decision carries labelled buttons; scheduled and posted
 * rows get bare icon actions and a smaller mark. A queue with nothing to review should look like nothing to
 * do.
 *
 * THE WORDS CAN BE CHANGED, in the two sections where changing them is still worth anything: something waiting
 * on a yes, and something that already went out wrong. Approve/reject alone made every draft a verdict on
 * someone else's sentence — a proposal that was one word off had to be thrown away and re-asked for, and a post
 * that failed for being thirty characters long could only be retried at exactly the length that failed. Editing
 * is a plain field on the same upsert every other action here uses (PostEditor.vue). Rows that are already on
 * their way deliberately do NOT get it: their "back to review" is the way in, so nothing can be rewritten on
 * the same row the publisher may already be reading. */

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
/* Keyed by the platform ID as well as by a draft, because the rail's rows ARE platforms — there is no post
 * beneath them to read the id off. An unnamed platform's fallback is CAPITALISED here rather than in CSS,
 * unlike the queue's own meta line (DraftMeta.vue): the same string is a picker option and a tooltip on a
 * phone, neither of which a text-transform on one row would reach. */
const nameOfPlatform = (platform: string): string =>
    platformCatalog.value.get(platform)?.name ?? `${platform.charAt(0).toUpperCase()}${platform.slice(1)}`;
const logoOfPlatform = (platform: string): string | undefined => platformCatalog.value.get(platform)?.logo;
const platformName = (draft: DraftSummary): string => nameOfPlatform(draft.platform);
const platformLogo = (draft: DraftSummary): string | undefined => logoOfPlatform(draft.platform);

/* THE RAIL'S ROWS ARE THE PLATFORMS THE QUEUE ACTUALLY HOLDS, never the ones we could post to: a row for a
 * platform with nothing in it promises a slice that turns out to be empty, and the rail offers no way back from
 * one. Alphabetical, because a rail that reorders itself as posts are approved moves the row you were reaching
 * for out from under the cursor. */
const scopeOf = (key: string, label: string, logo: string | undefined, subset: readonly DraftSummary[]): DraftScope => ({
    key,
    label,
    logo,
    total: subset.length,
    waiting: subset.filter((draft) => draft.status === `proposed`).length,
    failed: subset.filter((draft) => draft.status === `failed`).length,
});
const allScope = computed<DraftScope>(() => scopeOf(``, `All drafts`, undefined, drafts.value));
const platformScopes = computed<DraftScope[]>(() =>
    [...new Set(drafts.value.map((draft) => draft.platform))]
        .map((platform) =>
            scopeOf(
                platform,
                nameOfPlatform(platform),
                logoOfPlatform(platform),
                drafts.value.filter((draft) => draft.platform === platform),
            ),
        )
        .toSorted((left, right) => left.label.localeCompare(right.label)),
);

/* WHICH SLICE LIVES IN THE URL, replaced rather than pushed — Back should leave the page, not walk you through
 * every platform you clicked on the way. Derived from the query rather than mirrored into a ref, so there is one
 * direction of flow and no watcher pair to fight over what is shown.
 *
 * A slice the queue no longer holds is not a slice. Approving the last Reddit draft takes that row away, and a
 * link to it made yesterday falls back to everything rather than stranding its reader on a page about nothing. */
const route = useRoute();
const router = useRouter();
const scope = computed<string>({
    get: () => (typeof route.query[`platform`] === `string` ? route.query[`platform`] : ``),
    set: (value) => void router.replace({ name: `drafts`, query: { ...route.query, platform: value === `` ? undefined : value } }),
});
const activeScope = computed<DraftScope>(() => platformScopes.value.find((entry) => entry.key === scope.value) ?? allScope.value);
const railScope = computed<string>({ get: () => activeScope.value.key, set: (value) => (scope.value = value) });

// What the sections below are built from. The countdown strip and its clock deliberately read the WHOLE queue
// instead — see `holding`.
const visible = computed<DraftSummary[]>(() =>
    activeScope.value.key === `` ? drafts.value : drafts.value.filter((draft) => draft.platform === activeScope.value.key),
);

// Soonest first, undated last — the queue then reads in the order it will actually go out. A draft with no
// date does post as soon as it is picked up, but it is also the one still owed a decision about when, so it
// belongs at the end of the run rather than jumping the front of it.
const due = (draft: DraftSummary): number => draft.scheduledAt ?? Number.MAX_SAFE_INTEGER;
const bySoonest = (left: DraftSummary, right: DraftSummary): number => due(left) - due(right);

const ofStatus = (...statuses: DraftSummary[`status`][]): DraftSummary[] => visible.value.filter((draft) => statuses.includes(draft.status));

/* GOING OUT vs SCHEDULED — one section became two, because approving stopped meaning "sent" and started
 * meaning "sending in a minute unless you stop me" (publish-drafts.ts). Those are not the same row. A post
 * dated for Tuesday is a calendar entry: the thing to offer is a date control. A post forty seconds from being
 * public is the only thing on this page with a deadline, and the thing to offer is one obvious way to stop it.
 * Folding both into "Scheduled" put a countdown nobody was watching next to a date nobody was in a hurry about.
 *
 * THE WINDOW IS WIDER THAN THE HOLD, deliberately. A post someone dated for two minutes' time is every bit as
 * imminent as one that was just approved, and it would be strange for it to sit under a heading that implies
 * there is time. Anything already handed to the publisher (`posting`) is here too — it is the most imminent
 * thing there is. */
const GOING_OUT_WINDOW = 2 * 60_000;
const imminent = (draft: DraftSummary, at: number): boolean => draft.status === `posting` || (draft.scheduledAt ?? 0) - at <= GOING_OUT_WINDOW;

/* The clock, armed only while this page has something approved on it — an idle queue costs no tick. Armed off
 * the WHOLE queue rather than the slice on screen, because the strip it drives speaks for the whole queue. The
 * condition is deliberately NOT "is anything counting down", which is a function of `now` and would have this
 * ref arming itself. */
const now = useNow(() => drafts.value.some((draft) => draft.status === `approved` || draft.status === `posting`));

const failed = computed(() => ofStatus(`failed`).toSorted(bySoonest));
const needsReview = computed(() => ofStatus(`proposed`).toSorted(bySoonest));
const goingOut = computed(() =>
    ofStatus(`approved`, `posting`)
        .filter((draft) => imminent(draft, now.value))
        .toSorted(bySoonest),
);
const scheduled = computed(() =>
    ofStatus(`approved`)
        .filter((draft) => !imminent(draft, now.value))
        .toSorted(bySoonest),
);
// History, newest first. postedAt is optional in the contract, so a record without one sorts last rather than
// leaping to the top on a 0.
const posted = computed(() => ofStatus(`posted`).toSorted((left, right) => (right.postedAt ?? 0) - (left.postedAt ?? 0)));

/* EVERYTHING THAT IS COUNTING DOWN, whichever slice the rail is pointing at — the strip at the top of the page
 * and the button that stops all of it read this rather than the section below. A post is forty seconds from
 * being public whether or not the reader happens to be filtered to another platform, and a countdown that a
 * filter can hide is the one thing on this page that must never be hideable. */
const holding = computed(() => drafts.value.filter((draft) => draft.status === `approved` && imminent(draft, now.value)).toSorted(bySoonest));

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

/* ONE POST EDITED AT A TIME, saved as it is typed (useDraftEdit.ts). One at a time because the queue is read
 * top to bottom and a second open field is a second thing to keep track of; saved as typed because the row must
 * not have to rearrange itself around a Save button. */
const edit = useDraftEdit(async (draft, changes) => void (await save.mutateAsync({ ...draft, ...changes })));

// Every action on a post's TEXT writes the pending keystrokes first. The window between the last one and the
// debounce firing is precisely where someone fixes a word and immediately approves, and a post published from
// the list's copy would go out with that word still wrong.
const settled = (act: () => Promise<unknown>): Promise<void> =>
    run(async () => {
        await edit.flush();
        await act();
    }, `Could not update the draft.`);

const approve = (draft: DraftSummary): Promise<void> => settled(() => save.mutateAsync({ ...draft, status: `approved` }));

// The list it was fired against, not the live one: each approval moves a row out of `needsReview`, so reading
// the computed inside the loop would walk a list shrinking underneath it.
const approveAll = (): Promise<void> => {
    const queue = needsReview.value;
    approvingAll.value = false;
    return run(async () => {
        await edit.flush();
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

// The pencil is a toggle, and it is the ONLY thing the click changes: open, and the words become typeable
// where they already are; close, and the last of them is written on the way out.
const toggleEdit = (draft: DraftSummary): Promise<void> =>
    run(async () => {
        await (edit.isEditing(draft) ? edit.close() : edit.open(draft));
    }, `Could not save your changes.`);

/* CALLING IT BACK — the other half of a hold, and the reason the hold is worth having. It puts the post back in
 * review AND CLEARS THE DATE, which is the part that would be silently wrong if it were left out: the date on a
 * held post is a deadline the daemon wrote, not something the owner chose, and a draft carrying it back into
 * review would be re-approved into a deadline that had already passed — published instantly, with no second
 * minute to stop it. The one gesture on this page whose failure is a post nobody meant to send. */
const holdBack = (draft: DraftSummary): Promise<void> => patch(draft, { status: `proposed`, scheduledAt: undefined });

const holdBackAll = (): Promise<void> => {
    const queue = holding.value;
    return run(async () => {
        for (const draft of queue) {
            await save.mutateAsync({ ...draft, status: `proposed`, scheduledAt: undefined });
        }
    }, `Could not hold those posts back.`);
};

/* THE COUNTDOWN, SAID ONCE AT THE TOP OF THE PAGE. The section below states it per row, which is right when you
 * are looking at that row — and the whole point of a hold is the case where you are NOT: you approved, your eye
 * moved on, and the thing you want back is already three rows up. So while anything is counting down the page
 * carries one line saying what is about to happen and one button that stops all of it.
 *
 * `info`, not `warning`. Nothing is wrong: this is the system doing exactly what was asked, out loud. And an
 * explicit `key` so the stack treats each tick as the same notice re-worded rather than a new one arriving
 * every second. Absent below the ship tier, where there would be no way to act on it. */
const goingOutNotice = computed<NoticeModel | undefined>(() => {
    const soonest = holding.value[0];
    if (!canShip.value || soonest === undefined) {
        return undefined;
    }
    const count = holding.value.length;
    const when = countdownWords((soonest.scheduledAt ?? 0) - now.value);
    return {
        tone: `info`,
        title:
            count === 1
                ? `This post goes out ${when === `any moment now` ? when : `in ${when}`}.`
                : `${count} posts go out, the first ${when === `any moment now` ? when : `in ${when}`}.`,
        action: { label: count === 1 ? `Hold it back` : `Hold them back`, run: () => void holdBackAll() },
        key: `drafts-going-out`,
    };
});

// What a draft is called where it has to be named in one line — a confirm's list, an action's accessible name.
// The title if the platform wanted one, else the post's opening line.
const headline = (draft: DraftSummary): string => draft.title ?? draft.content.split(`\n`)[0] ?? draft.id;

/* HOW BIG THE POST IS, against the room the platform gives it. The one property of a draft that decides whether
 * it can post at all and that reading it cannot tell you — 30 characters over on X is not a worse post, it is
 * no post — so it sits in the footer of every row that still owes a decision, and turns red when it is the
 * reason the draft will fail. Platforms with no well-known cap (postText.ts) get a plain count, and only once
 * the post is long enough for its size to be a question at all. */
const OVERSIZED = 280;
// Counted off the FIELD while one is open (useDraftEdit.ts), so the number moves with the words being typed —
// it is the one fact on the row that has to, since going over is the reason a post fails outright, and it
// updating in place is also what makes a separate editor footer unnecessary.
const lengthOf = (draft: DraftSummary): string | undefined => {
    const limit = limitOf(draft.platform);
    const count = edit.liveLength(draft);
    if (limit !== undefined) {
        return `${count.toLocaleString()} / ${limit.toLocaleString()}`;
    }
    return count > OVERSIZED || edit.isEditing(draft) ? `${count.toLocaleString()} characters` : undefined;
};
const isOver = (draft: DraftSummary): boolean => edit.liveLength(draft) > (limitOf(draft.platform) ?? Infinity);

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

/* THE PENCIL SITS WITH THE OTHER ACTIONS, which is the fix for where it used to be. It began life as a muted
 * phrase in the row's footer, on the reasoning that rewriting a post is rarer than approving one and should not
 * draw like a rival to Approve. The reasoning was fine and the placement was not: it put one of the row's three
 * actions at the bottom-left while the other two sat at the top-right, so "what can I do to this post" had two
 * answers in two places. Quiet is a matter of WEIGHT, not of distance — a bare icon button beside the trash is
 * quiet and still findable, and the cluster now answers the question once.
 *
 * IT IS A TOGGLE, AND IT LIGHTS UP. The pressed state is the only thing on the row that changes when editing
 * opens; everything else — the trash, Approve, the schedule, the count — stays exactly where it was. */
const EDIT_ACTIVE = `bg-overlay text-content`;
</script>

<template>
    <SplitView
        title="Drafts"
        :description="
            activeScope.key === ``
                ? `Posts your agent prepared for you to approve.`
                : `${activeScope.label} posts your agent prepared for you to approve.`
        "
    >
        <template #info>
            <InfoHint label="How drafts are published">
                <span class="block text-xs font-semibold text-content">From proposal to post</span>
                <span class="mt-2 block text-xs text-muted">
                    Your agent writes drafts while it works and never posts one by itself. Approving one starts a short countdown you can stop — when
                    it runs out the post goes to that platform, or waits for the date you gave it. Rejecting deletes the draft.
                </span>
            </InfoHint>
        </template>

        <!-- Whole-page banners: the countdown speaks for every platform, and a file that could not be parsed
             has no platform to be filed under. Both belong above the split rather than inside the slice. -->
        <template #strips>
            <NoticeStack :of="[actionError, listNotice, goingOutNotice]" />
            <div v-if="invalid.length > 0" :class="cmp.alertWarning()">
                <Icon name="exclamation-triangle" class="mr-1.5" />{{ invalid.length }} draft file{{ invalid.length === 1 ? "" : "s" }} couldn't be
                read and won't post: <span class="font-mono">{{ invalid.join(", ") }}</span>
            </div>
        </template>

        <!-- One platform's queue, or all of them. The rail NARROWS the body rather than selecting a document, so
             <SplitView> folds it above the queue on a phone (mobile="collapse", the default) instead of covering
             it, and <DraftRail> already swaps itself to a Picker at that width. An empty queue gets no index:
             a column of nothing pointing at nothing. -->
        <template v-if="!isEmpty" #rail>
            <DraftRail v-model="railScope" :all="allScope" :platforms="platformScopes" />
        </template>

        <template #detail>
            <div class="scrollbar-thin flex min-h-0 flex-1 flex-col overflow-y-auto pr-1">
                <!-- Nothing proposed, nothing sent, nothing broken. The rail hides its tile in this state, so the
                     page is only reached deliberately — and it owes an explanation of what would ever put
                     something here. -->
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
                                <!-- A post that failed for being too long can only be retried at the length that failed,
                                     unless the words themselves can be changed — so the pencil is here too. -->
                                <button
                                    v-if="canShip"
                                    type="button"
                                    :class="cmp.iconButton(`h-8 w-8`, edit.isEditing(draft) ? EDIT_ACTIVE : ``)"
                                    :aria-label="`Edit ${headline(draft)}`"
                                    :aria-pressed="edit.isEditing(draft)"
                                    v-tooltip.top="edit.isEditing(draft) ? `Done editing` : `Edit the post`"
                                    @click="toggleEdit(draft)"
                                >
                                    <Icon name="pencil" />
                                </button>
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
                                    label="Retry"
                                    size="small"
                                    severity="secondary"
                                    :disabled="save.isPending.value"
                                    @click="settled(() => save.mutateAsync({ ...draft, status: `approved` }))"
                                >
                                    <template #icon><Icon name="refresh" /></template>
                                </Button>
                            </template>
                            <template #below>
                                <div :class="POST_COLUMN">
                                    <PostEditor
                                        v-if="edit.isEditing(draft)"
                                        :draft="draft"
                                        v-model:content="edit.content.value"
                                        v-model:title="edit.title.value"
                                        @touch="edit.touch()"
                                        @close="toggleEdit(draft)"
                                    />
                                    <DraftPost v-else :draft="draft" />
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
                            <button
                                v-if="canShip"
                                type="button"
                                :class="cmp.linkButton()"
                                :disabled="save.isPending.value"
                                @click="approvingAll = true"
                            >
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
                            <!-- THE ROW'S THREE ACTIONS, TOGETHER AND FIXED. Edit, reject, approve — in the order they
                                 escalate, and none of them moves, hides or swaps when the editor opens. Approving with
                                 a field still open is safe because the click writes the pending keystrokes first
                                 (`settled`), which is what let the mid-edit disappearing act go. -->
                            <template #control>
                                <button
                                    v-if="canShip"
                                    type="button"
                                    :class="cmp.iconButton(`h-8 w-8`, edit.isEditing(draft) ? EDIT_ACTIVE : ``)"
                                    :aria-label="`Edit ${headline(draft)}`"
                                    :aria-pressed="edit.isEditing(draft)"
                                    v-tooltip.top="edit.isEditing(draft) ? `Done editing` : `Edit the post`"
                                    @click="toggleEdit(draft)"
                                >
                                    <Icon name="pencil" />
                                </button>
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
                                <Button v-if="canShip" label="Approve" size="small" :disabled="save.isPending.value" @click="approve(draft)">
                                    <template #icon><Icon name="check" /></template>
                                </Button>
                            </template>
                            <template #below>
                                <div :class="POST_COLUMN">
                                    <!-- The post, or the same post with a caret in it — same column, same measure, same
                                         type. Unclamped up to a screenful either way: this is the section where a
                                         decision is owed, and the post's own words are what the decision is about. -->
                                    <PostEditor
                                        v-if="edit.isEditing(draft)"
                                        :draft="draft"
                                        v-model:content="edit.content.value"
                                        v-model:title="edit.title.value"
                                        @touch="edit.touch()"
                                        @close="toggleEdit(draft)"
                                    />
                                    <DraftPost v-else :draft="draft" />

                                    <!-- The facts that DECIDE the post rather than describe it: when it goes, and
                                         whether it fits where it is going. Present in both states and unmoved by the
                                         switch — the count simply starts following the keystrokes. -->
                                    <div :class="FACTS">
                                        <ScheduleControl
                                            :at="draft.scheduledAt"
                                            :label="headline(draft)"
                                            @change="patch(draft, { scheduledAt: $event })"
                                        />
                                        <span v-if="lengthOf(draft)" :class="isOver(draft) ? `text-danger` : ``">{{ lengthOf(draft) }}</span>
                                    </div>
                                    <!-- The agent's own note about the draft, under everything it is a note about. -->
                                    <p v-if="noteOf(draft)" :class="NOTE" v-tooltip.top="noteOf(draft)">{{ noteOf(draft) }}</p>
                                </div>
                            </template>
                        </Row>
                    </RowGroup>

                    <!-- ABOUT TO BE PUBLIC, and the only thing on this page with a deadline. Directly under the review
                         queue rather than at the top of the page, because that is where an approved row LANDS: it
                         leaves the section above and appears immediately below it, which reads as the post moving one
                         step along rather than as the page rearranging itself under the click. The strip at the very
                         top is what covers the case where you are no longer looking here at all.

                         ONE LABELLED BUTTON, where the sections around it use bare icons — the page's weight rule
                         applied to the state it was written for. Stopping a post is urgent, singular, and cannot be
                         something you go hunting for behind a tooltip. -->
                    <RowGroup v-if="goingOut.length > 0" label="Going out" :count="goingOut.length">
                        <Row v-for="draft in goingOut" :key="draft.id" density="compact">
                            <template #lead><BrandMark :size="22" :name="platformName(draft)" :logo="platformLogo(draft)" /></template>
                            <template #description><DraftMeta :name="platformName(draft)" :target="draft.target" /></template>
                            <template #meta>
                                <!-- Handed over: the daemon is mid-send, so there is nothing left to stop and the row
                                     says so instead of offering a button that would lose the race. -->
                                <StatusBadge v-if="draft.status === `posting`" variant="info" label="sending" size="xs" :dot="true" />
                                <span v-else class="tabular-nums text-warning">{{ countdownWords((draft.scheduledAt ?? 0) - now) }}</span>
                            </template>
                            <template v-if="draft.status === `approved`" #control>
                                <Button
                                    v-if="canShip"
                                    label="Stop"
                                    size="small"
                                    severity="secondary"
                                    :disabled="save.isPending.value"
                                    :aria-label="`Stop ${headline(draft)} and put it back in review`"
                                    v-tooltip.top="`Back to review — nothing is sent`"
                                    @click="holdBack(draft)"
                                >
                                    <template #icon><Icon name="undo" /></template>
                                </Button>
                            </template>
                            <template #below>
                                <div :class="QUIET_COLUMN"><DraftPost :draft="draft" tone="quiet" /></div>
                            </template>
                        </Row>
                    </RowGroup>

                    <!-- Approved and waiting for a date that is still some way off. Quiet by design: the decision is
                         made and there is time, so the row's job is to say when it goes and otherwise stay out of the
                         way of the sections above it. -->
                    <RowGroup v-if="scheduled.length > 0" label="Scheduled" :count="scheduled.length">
                        <Row v-for="draft in scheduled" :key="draft.id" density="compact">
                            <template #lead><BrandMark :size="22" :name="platformName(draft)" :logo="platformLogo(draft)" /></template>
                            <template #description><DraftMeta :name="platformName(draft)" :target="draft.target" /></template>
                            <template #control>
                                <div v-if="canShip" class="text-2xs text-subtle">
                                    <ScheduleControl
                                        :at="draft.scheduledAt"
                                        :label="headline(draft)"
                                        @change="patch(draft, { scheduledAt: $event })"
                                    />
                                </div>
                                <button
                                    v-if="canShip"
                                    type="button"
                                    :class="cmp.iconButton()"
                                    :aria-label="`Put ${headline(draft)} back in review`"
                                    v-tooltip.top="`Put back in review`"
                                    @click="holdBack(draft)"
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
                                <span v-if="draft.postedAt !== undefined" v-tooltip.top="formatTimestamp(draft.postedAt)">{{
                                    timeAgo(draft.postedAt)
                                }}</span>
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
            </div>
        </template>
    </SplitView>
</template>
