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

/* Approvals: the inbox of things the agent prepared and may not do until the owner says yes. The agent writes
 * one JSON file per item into .intentic/config/approvals/ (taught by the daemon's approvals skill); this page is
 * the owner's approve / edit / reschedule / reject side. There is no create dialog here: items originate with
 * the agent, never the UI.
 *
 * ONE QUEUE, TWO KINDS, ONE SET OF VERBS. A post to publish and an action to carry out (a booking, a payment, a
 * message sent as the owner) are the same decision: the agent prepared an exact thing, the owner's click
 * releases it, a machine does precisely that thing. So the ENVELOPE of every row is the same, who it acts as,
 * when it goes, approve / reject / hold back, the countdown, and only the BODY differs: a post is read as a
 * post (PostBody.vue, editable in place), an action as a headline and the specifics under it (ActionBody.vue,
 * not editable: an owner rewriting an agent's brief is approving something nobody proposed). A third kind is
 * one body component and nothing else on this page.
 *
 * AND THE AUTOMATIONS HELD AT THE DOOR, from the daemon's other queue (useHeldWakes.ts). A `requireApproval`
 * automation that fired is exactly this page's shape of decision, a prepared wake waiting for a yes, and it used
 * to badge the Automations tile, a "Set up" shelf, for a "Judge" decision. It is a section here now, with the
 * verbs it always had: approve runs it, reject drops it, and a countdown hold shows its clock with Start now and
 * Cancel. Different store, different route, same page, because the owner's question is "what is waiting on me"
 * and the answer should not depend on which process wrote the file.
 *
 * AN INDEX BESIDE THE QUEUE (<SplitView>), the shape Capabilities, Pipelines and the hubs already use, and the
 * app's standard page width with it. It was a narrow column with every section stacked down one scroll: fine
 * for a handful of posts on one platform, and the thing that stops scaling the moment an agent proposes across
 * several: what is waiting on you for one platform sits below everything the others have ever posted. The rail
 * is bounded by how many platforms a workspace posts to plus one row for actions, so the body stays finite as
 * the queue behind it grows (see <ApprovalRail>). It NARROWS rather than selects: every section reads the same
 * whether you came in via All approvals or via one slice, and the slice lives in the URL, so "the Reddit queue"
 * is a link.
 *
 * APPROVING DOES NOT DO IT. It starts a minute (approvals-execution.ts): the daemon dates the item one hold into
 * the future and sleeps until exactly then, and for that minute the row sits in Going ahead with a live count
 * and one button that calls it back. A post is public and permanent the instant it lands, a booking is charged,
 * and the gap between realising and reaching for the mouse is about two seconds, so the whole design of this
 * page's second half is that the seconds exist and are visible. An item carrying a date of its own keeps it and
 * simply waits.
 *
 * THE THING IS THE SUBJECT OF THE ROW, and it is READ rather than glanced at. Everything about where an item is
 * going lives on one muted line beneath a mark; under it the post is set as a post, or the action as a headline
 * with its specifics: a capped measure, body type, paragraph rhythm, because a row as wide as the window runs
 * ~110 characters to the line, and past about 75 the eye loses the start of the next one.
 *
 * ONE SECTION PER DECISION, in the order the queue owes them: something broke, something is waiting on you,
 * something is seconds from happening, something is on the calendar, something already happened. A status
 * badge survives only where its section does not already state it (`in progress`, inside Going ahead): every
 * other badge was re-labelling its own group. Each section sorts by the field it is actually read for: soonest
 * first while something can still be changed, newest first once it is history.
 *
 * WEIGHT MARKS PRIORITY. Only the section that owes a decision carries labelled buttons; scheduled and done rows
 * get bare icon actions and a smaller mark. A queue with nothing to review should look like nothing to do.
 *
 * THE WORDS OF A POST CAN BE CHANGED, in the two sections where changing them is still worth anything: something
 * waiting on a yes, and something that already went out wrong. Approve/reject alone made every post a verdict
 * on someone else's sentence: a proposal that was one word off had to be thrown away and re-asked for. Editing
 * is a plain field on the same upsert every other action here uses (PostEditor.vue). Rows that are already on
 * their way deliberately do NOT get it: their "back to review" is the way in, so nothing can be rewritten on
 * the same row the executor may already be reading. */

const { approvals, invalid, isLoading, error: listError, save, remove } = useApprovals();
const { held, error: heldError, approve: approveWake, reject: rejectWake } = useHeldWakes();
// Only drawn once the wait has earned it: a warm queue answers well inside the reveal delay.
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
// Releasing is the ship tier: below maintainer the queue is a read, the items, their schedule, their status:
// with every approve/reject/reschedule affordance absent (the daemon floors the mutations the same way).
// Watching what is about to happen is exactly what a viewer is for.
const canShip = computed(() => roleAtLeast(host().sandbox.role(), `maintainer`));
const { notice: actionError, run } = useAsyncAction();

const isPost = (item: ApprovalSummary): item is PostApprovalSummary => item.kind === `post`;
const isAction = (item: ApprovalSummary): item is ActionApprovalSummary => item.kind === `action`;

/* WHO POSTS IT, from the manifest that owns that fact. `platform` is a bare string by contract (a new platform
 * needs no contract change) and it is the id of the capability whose skill does the posting, so the enabled
 * extensions' own catalog entries already hold its display name and brand slug, including the detail nothing
 * here could have guessed: X's mark is black, so its entry forces a light one. A platform with no installed
 * connector still renders, because BrandMark falls through to a monogram, and that is the case that has to
 * keep working: a post can be proposed for somewhere this sandbox cannot yet post. */
const platformCatalog = usePlatformCatalog();
/* Keyed by the platform ID as well as by an item, because the rail's rows ARE platforms: there is no post
 * beneath them to read the id off. An unnamed platform's fallback is CAPITALISED here rather than in CSS,
 * unlike the queue's own meta line (ApprovalMeta.vue): the same string is a picker option and a tooltip on a
 * phone, neither of which a text-transform on one row would reach. */
const nameOfPlatform = (platform: string): string =>
    platformCatalog.value.get(platform)?.name ?? `${platform.charAt(0).toUpperCase()}${platform.slice(1)}`;
const logoOfPlatform = (platform: string): string | undefined => platformCatalog.value.get(platform)?.logo;
// What the meta line calls the item: the platform's name for a post, and plainly "Action" for an action.
const nameOf = (item: ApprovalSummary): string => (isPost(item) ? nameOfPlatform(item.platform) : `Action`);
const targetOf = (item: ApprovalSummary): string | undefined => (isPost(item) ? item.target : undefined);

/* THE RAIL'S ROWS ARE THE SLICES THE QUEUE ACTUALLY HOLDS, never the ones we could post to: a row for a
 * platform with nothing in it promises a slice that turns out to be empty, and the rail offers no way back from
 * one. Platforms alphabetical, because a rail that reorders itself as items are approved moves the row you were
 * reaching for out from under the cursor; actions and held automations last, as the rows that are not a place. */
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

/* WHICH SLICE LIVES IN THE URL, replaced rather than pushed: Back should leave the page, not walk you through
 * every slice you clicked on the way. Derived from the query rather than mirrored into a ref, so there is one
 * direction of flow and no watcher pair to fight over what is shown.
 *
 * A slice the queue no longer holds is not a slice. Approving the last Reddit post takes that row away, and a
 * link to it made yesterday falls back to everything rather than stranding its reader on a page about nothing. */
const scope = computed<string>({
    get: () => host().route.query()[`scope`] ?? ``,
    set: (value) => host().route.setQuery({ scope: value === `` ? undefined : value }),
});
const activeScope = computed<ApprovalScope>(() => scopes.value.find((entry) => entry.key === scope.value) ?? allScope.value);
const railScope = computed<string>({ get: () => activeScope.value.key, set: (value) => (scope.value = value) });

// What the sections below are built from. The countdown strip and its clock deliberately read the WHOLE queue
// instead: see `holding`.
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

// Soonest first, undated last: the queue then reads in the order it will actually happen. An item with no date
// does go ahead as soon as it is picked up, but it is also the one still owed a decision about when, so it
// belongs at the end of the run rather than jumping the front of it.
const due = (item: ApprovalSummary): number => item.scheduledAt ?? Number.MAX_SAFE_INTEGER;
const bySoonest = (left: ApprovalSummary, right: ApprovalSummary): number => due(left) - due(right);

const ofStatus = (...statuses: ApprovalSummary[`status`][]): ApprovalSummary[] => visible.value.filter((item) => statuses.includes(item.status));

/* GOING AHEAD vs SCHEDULED: one section became two, because approving stopped meaning "done" and started
 * meaning "doing it in a minute unless you stop me" (approvals-execution.ts). Those are not the same row. An
 * item dated for Tuesday is a calendar entry: the thing to offer is a date control. An item forty seconds from
 * happening is the only thing on this page with a deadline, and the thing to offer is one obvious way to stop
 * it. Folding both into "Scheduled" put a countdown nobody was watching next to a date nobody was in a hurry
 * about.
 *
 * THE WINDOW IS WIDER THAN THE HOLD, deliberately. An item someone dated for two minutes' time is every bit as
 * imminent as one that was just approved, and it would be strange for it to sit under a heading that implies
 * there is time. Anything already handed to the executor (`running`) is here too: it is the most imminent thing
 * there is. */
const GOING_AHEAD_WINDOW = 2 * 60_000;
const imminent = (item: ApprovalSummary, at: number): boolean => item.status === `running` || (item.scheduledAt ?? 0) - at <= GOING_AHEAD_WINDOW;

/* The clock, armed only while this page has something approved on it: an idle queue costs no tick. Armed off
 * the WHOLE queue rather than the slice on screen, because the strip it drives speaks for the whole queue. The
 * condition is deliberately NOT "is anything counting down", which is a function of `now` and would have this
 * ref arming itself. */
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
// History, newest first. finishedAt is optional in the contract, so a record without one sorts last rather than
// leaping to the top on a 0.
const done = computed(() => ofStatus(`done`).toSorted((left, right) => (right.finishedAt ?? 0) - (left.finishedAt ?? 0)));

/* EVERYTHING THAT IS COUNTING DOWN, whichever slice the rail is pointing at: the strip at the top of the page
 * and the button that stops all of it read this rather than the section below. A post is forty seconds from
 * being public whether or not the reader happens to be filtered to another slice, and a countdown that a
 * filter can hide is the one thing on this page that must never be hideable. */
const holding = computed(() => approvals.value.filter((item) => item.status === `approved` && imminent(item, now.value)).toSorted(bySoonest));

const isEmpty = computed(() => approvals.value.length === 0 && invalid.value.length === 0 && held.value.length === 0);

/* A HELD WAKE'S CLOCK. A countdown hold runs ITSELF when the timer passes: the row's job is to say so and keep
 * the cancel in reach. The daemon releases on its own coarser tick and only on a quiet fleet, so "starting…"
 * (past due, fleet busy or scan pending) is a real state and gets said rather than showing a negative number. */
const startsIn = (autoRunAt: number): string => {
    const seconds = Math.ceil((autoRunAt - now.value) / 1_000);
    return seconds <= 0 ? `starting…` : `starts in ${seconds}s unless you cancel`;
};
const wakeName = (wake: AutomationApproval): string => wake.title ?? wake.automationId;

// Release a held wake (the agent runs now) or drop it (never runs). Both go through the same strip as the
// queue's own errors: one place for "that click did not take".
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

// Approve, retry, put-back and reschedule are all a re-post of the whole file with one field changed (the
// daemon upserts by id). Errors surface in the strip at the top; the query refetch reconciles the row.
const patch = <T extends ApprovalSummary>(item: T, changes: Partial<T>): Promise<void> =>
    run(async () => {
        await save.mutateAsync({ ...item, ...changes });
    }, `Could not update it.`);

/* ONE POST EDITED AT A TIME, saved as it is typed (usePostEdit.ts). One at a time because the queue is read
 * top to bottom and a second open field is a second thing to keep track of; saved as typed because the row must
 * not have to rearrange itself around a Save button. */
const edit = usePostEdit(async (post, changes) => void (await save.mutateAsync({ ...post, ...changes })));

// Every action on a post's TEXT writes the pending keystrokes first. The window between the last one and the
// debounce firing is precisely where someone fixes a word and immediately approves, and a post published from
// the list's copy would go out with that word still wrong.
const settled = (act: () => Promise<unknown>): Promise<void> =>
    run(async () => {
        await edit.flush();
        await act();
    }, `Could not update it.`);

const approve = (item: ApprovalSummary): Promise<void> => settled(() => save.mutateAsync({ ...item, status: `approved` }));

// The list it was fired against, not the live one: each approval moves a row out of `needsReview`, so reading
// the computed inside the loop would walk a list shrinking underneath it.
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

// The pencil is a toggle, and it is the ONLY thing the click changes: open, and the words become typeable
// where they already are; close, and the last of them is written on the way out.
const toggleEdit = (post: PostApprovalSummary): Promise<void> =>
    run(async () => {
        await (edit.isEditing(post) ? edit.close() : edit.open(post));
    }, `Could not save your changes.`);

/* CALLING IT BACK: the other half of a hold, and the reason the hold is worth having. It puts the item back in
 * review AND CLEARS THE DATE, which is the part that would be silently wrong if it were left out: the date on a
 * held item is a deadline the daemon wrote, not something the owner chose, and an item carrying it back into
 * review would be re-approved into a deadline that had already passed: done instantly, with no second minute to
 * stop it. The one gesture on this page whose failure is a post nobody meant to send. */
const holdBack = (item: ApprovalSummary): Promise<void> => patch(item, { status: `proposed`, scheduledAt: undefined });

const holdBackAll = (): Promise<void> => {
    const queue = holding.value;
    return run(async () => {
        for (const item of queue) {
            await save.mutateAsync({ ...item, status: `proposed`, scheduledAt: undefined });
        }
    }, `Could not hold those back.`);
};

/* THE COUNTDOWN, SAID ONCE AT THE TOP OF THE PAGE. The section below states it per row, which is right when you
 * are looking at that row, and the whole point of a hold is the case where you are NOT: you approved, your eye
 * moved on, and the thing you want back is already three rows up. So while anything is counting down the page
 * carries one line saying what is about to happen and one button that stops all of it.
 *
 * `info`, not `warning`. Nothing is wrong: this is the system doing exactly what was asked, out loud. And an
 * explicit `key` so the stack treats each tick as the same notice re-worded rather than a new one arriving
 * every second. Absent below the ship tier, where there would be no way to act on it. */
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

// What an item is called where it has to be named in one line: a confirm's list, an action's accessible name,
// the strip. A post's title if the platform wanted one, else its opening line; an action's summary.
const headline = (item: ApprovalSummary): string => (isPost(item) ? (item.title ?? item.content.split(`\n`)[0] ?? item.id) : item.summary);

/* HOW BIG THE POST IS, against the room the platform gives it. The one property of a post that decides whether
 * it can go out at all and that reading it cannot tell you: 30 characters over on X is not a worse post, it is
 * no post, so it sits in the footer of every post row that still owes a decision, and turns red when it is the
 * reason the post will fail. Platforms with no well-known cap (postText.ts) get a plain count, and only once the
 * post is long enough for its size to be a question at all. */
const OVERSIZED = 280;
// Counted off the FIELD while one is open (usePostEdit.ts), so the number moves with the words being typed: it
// is the one fact on the row that has to, since going over is the reason a post fails outright, and it updating
// in place is also what makes a separate editor footer unnecessary.
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

/* THE AGENT'S OWN NOTE about a post, which is what `title` holds everywhere the platform doesn't publish one
 * (postText.ts): why this post, which thread, what it is not saying. Worth keeping, it is the reasoning behind
 * the thing being approved, and worth keeping SMALL: rendered as a headline it was a three-line bold block
 * above a post it had no business outweighing. One muted line, the rest on hover. */
const noteOf = (item: ApprovalSummary): string | undefined => (isPost(item) && !postsATitle(item.platform, item.target) ? item.title : undefined);

// A result that is an address is somewhere to go; anything else is a sentence to read.
const resultHref = (item: ApprovalSummary): string | undefined => (item.result?.startsWith(`http`) === true ? item.result : undefined);

/* ONE COLUMN PER ROW. The mark sits in a gutter and everything else: the meta line, the body, the facts under
 * it: starts at the same left edge, the way every surface that shows a post composes one. The indent is the mark
 * plus <Row>'s own gap (28 + 10, and 22 + 10 on the compact tiers), so it tracks the header beside it rather
 * than being a number that happens to look right today. Only from `sm` up: on a phone those 38px are a tenth of
 * the line, and an aligned column costs more than a hanging one is worth. */
const POST_COLUMN = `sm:pl-10`;
const QUIET_COLUMN = `sm:pl-8`;

// An action's mark: the same footprint as a brand mark, wearing the glyph the rail uses for its slice, so an
// action and its slice are recognised by the same thing, exactly as a post and its platform are.
const ACTION_MARK = `flex shrink-0 items-center justify-center rounded-md bg-overlay text-muted`;

// The row's footer: facts about the item, wrapping on a narrow screen, quieter than the body itself, and held
// to the body's own measure so the note at its end truncates against the column rather than the window.
const FACTS = `mt-3 flex max-w-read flex-wrap items-center gap-x-3 gap-y-1 text-xs text-muted`;

// And the note under it: two lines at most, the rest on hover. Below the post rather than above it, because it
// is the agent talking ABOUT the post: a reader who mistakes it for the post has read the wrong thing.
const NOTE = `mt-1.5 line-clamp-2 max-w-read text-2xs leading-relaxed text-subtle`;

/* THE PENCIL SITS WITH THE OTHER ACTIONS, which is the fix for where it used to be. It began life as a muted
 * phrase in the row's footer, on the reasoning that rewriting a post is rarer than approving one and should not
 * draw like a rival to Approve. The reasoning was fine and the placement was not: it put one of the row's three
 * actions at the bottom-left while the other two sat at the top-right, so "what can I do to this post" had two
 * answers in two places. Quiet is a matter of WEIGHT, not of distance: a bare icon button beside the trash is
 * quiet and still findable, and the cluster now answers the question once.
 *
 * IT IS A TOGGLE, AND IT LIGHTS UP. The pressed state is the only thing on the row that changes when editing
 * opens; everything else (the trash, Approve, the schedule, the count) stays exactly where it was. */
const EDIT_ACTIVE = `bg-overlay text-content`;
</script>

<template>
    <!-- `scroll="page"`: a QUEUE is a feed, and the rail narrows it rather than selecting a document out of it,
         which is the `page` case exactly. A row is tall (a mark, a body that folds at 20rem, a schedule and four
         controls), so a clamped pane showed two of them and hid the rest behind a scrollbar inside a card inside
         a page. -->
    <SplitView title="Approvals" scroll="page" :scroll-key="railScope">
        <!-- Whole-page banners: the countdown speaks for every slice, and a file that could not be parsed has
             no slice to be filed under. Both belong above the split rather than inside the slice. -->
        <template #strips>
            <NoticeStack :of="[actionError, listNotice, heldNotice, goingAheadNotice]" />
            <Notice v-if="invalid.length > 0" tone="warning">
                {{ invalid.length }} file{{ invalid.length === 1 ? "" : "s" }} couldn't be read and won't run:
                <span class="font-mono">{{ invalid.join(", ") }}</span>
            </Notice>
        </template>

        <!-- One slice of the queue, or all of it. The rail NARROWS the body rather than selecting a document, so
             <SplitView> folds it above the queue on a phone (mobile="collapse", the default) instead of covering
             it, and <ApprovalRail> already swaps itself to a Picker at that width. An empty queue gets no index:
             a column of nothing pointing at nothing. -->
        <template v-if="!isEmpty" #rail>
            <ApprovalRail v-model="railScope" :all="allScope" :scopes="scopes" />
        </template>

        <template #detail>
            <div class="flex flex-col">
                <!-- Before the queue is read it is indistinguishable from an empty one, and the sentence below
                     is a claim about the reader's agent that nothing has yet checked. Drawn as the rows that
                     are coming instead: a queue of items, each a mark, a line of text and a control. -->
                <template v-if="isLoading">
                    <RowGroup v-if="outline" role="status" aria-busy="true">
                        <template #label><span class="skeleton block h-2.5 w-20" aria-hidden="true" /></template>
                        <span class="sr-only">Reading the approvals queue…</span>
                        <SkeletonRows :rows="3" description control />
                    </RowGroup>
                </template>

                <!-- Nothing proposed, nothing done, nothing broken. The rail hides its tile in this state, so the
                     page is only reached deliberately, and it owes an explanation of what would ever put
                     something here. -->
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
                                <!-- A post that failed for being too long can only be retried at the length that failed,
                                     unless the words themselves can be changed, so the pencil is here too. -->
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
                                    <!-- The reason, in the row. It used to live in a tooltip on the status badge: the
                                         one state whose entire content is an explanation, hidden behind a hover. -->
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
                            <!-- THE ROW'S THREE ACTIONS, TOGETHER AND FIXED. Edit (posts only), reject, approve: in the
                                 order they escalate, and none of them moves, hides or swaps when the editor opens.
                                 Approving with a field still open is safe because the click writes the pending
                                 keystrokes first (`settled`), which is what let the mid-edit disappearing act go. -->
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
                                    <!-- The body, or the same post with a caret in it: same column, same measure, same
                                         type. Unclamped up to a screenful either way: this is the section where a
                                         decision is owed, and the thing's own words are what the decision is about. -->
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

                                    <!-- The facts that DECIDE the item rather than describe it: when it happens, and
                                         for a post whether it fits where it is going. Present in both states and
                                         unmoved by the switch: the count simply starts following the keystrokes. -->
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

                    <!-- AUTOMATIONS HELD AT THE DOOR. One section for both shapes of hold, because the reader's question
                         is the same for each: "this fired, and the agent has not run: do I want it to?" A hold with
                         no deadline waits for a yes; a countdown hold says when it will start by itself and offers
                         to start it now or call it off. The payload rides under the row, truncated, because for a
                         Front Desk or a webhook it IS the reason the wake exists. -->
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

                    <!-- ABOUT TO HAPPEN, and the only thing on this page with a deadline. Directly under the review
                         queue rather than at the top of the page, because that is where an approved row LANDS: it
                         leaves the section above and appears immediately below it, which reads as the item moving one
                         step along rather than as the page rearranging itself under the click. The strip at the very
                         top is what covers the case where you are no longer looking here at all.

                         ONE LABELLED BUTTON, where the sections around it use bare icons: the page's weight rule
                         applied to the state it was written for. Stopping something is urgent, singular, and cannot be
                         something you go hunting for behind a tooltip. -->
                    <RowGroup v-if="goingAhead.length > 0" label="Going ahead" :count="goingAhead.length">
                        <Row v-for="item in goingAhead" :key="item.id" density="compact">
                            <template #lead>
                                <BrandMark v-if="isPost(item)" :size="22" :name="nameOf(item)" :logo="logoOfPlatform(item.platform)" />
                                <span v-else :class="ACTION_MARK" class="h-6 w-6 text-xs"><Icon name="bolt" /></span>
                            </template>
                            <template #description><ApprovalMeta :name="nameOf(item)" :target="targetOf(item)" :acts-as="item.actsAs" /></template>
                            <template #meta>
                                <!-- Handed over: the daemon is mid-run, so there is nothing left to stop and the row
                                     says so instead of offering a button that would lose the race. -->
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

                    <!-- Approved and waiting for a date that is still some way off. Quiet by design: the decision is
                         made and there is time, so the row's job is to say when it happens and otherwise stay out of
                         the way of the sections above it. -->
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

                    <!-- History. Nothing here can be acted on any more, so it carries no schedule and no approval:
                         only what happened, where, and when, and the result where there is one. -->
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

                <!-- Rejecting deletes the file: there is no undo and no trash to fish it back out of, which is exactly
                     what this dialog is for. A done row asks the same question about a different thing, and says so:
                     deleting the record does not undo what was done. -->
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
