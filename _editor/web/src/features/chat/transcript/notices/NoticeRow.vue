<script setup lang="ts">
import { AnchoredOverlay, formatElapsed, useHoverIntent } from "@intentic/ui";
import { useNow } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { sandboxNoticeOf } from "@intentic/sandbox-contract/events/sandbox-notice";
import { isHomeConversationId } from "@intentic/sandbox-contract/ids/conversation-ids";
import { type Component, computed, ref, useTemplateRef } from "vue";
import { useAudience } from "../../../../app/useAudience";
import { useAgents } from "../../../../models/fleet/useAgents";
import { landOfRow } from "../../../../models/home/homeCommits";
import { usePaneView } from "../../../../models/conversations/panel/useChat-view";
import type { ChatIncident } from "../../../../models/conversations/transcript/chatIncidents";
import { noticeFailure, noticeLine } from "../../../../models/conversations/transcript/sandboxNotice";
import type { ChatMessage } from "../../../../models/conversations/transcript/transcript";
import { chatRouteWait } from "../../routing/chatRoute";
import { wakeEntries, wakesIcon } from "./noticeCard";
import NoticeCard from "./NoticeCard.vue";
import NoticeDepsInstall from "./NoticeDepsInstall.vue";
import NoticeHeld from "./NoticeHeld.vue";
import NoticeHomeCommit from "./NoticeHomeCommit.vue";
import { agentNoticeLookOf, isTurnChecks, noticeIconOf } from "./noticeLook";
import NoticeSwitchModel from "./NoticeSwitchModel.vue";
import NoticeWatchStop from "./NoticeWatchStop.vue";

/* A META ROW (chat.css `.chat-meta`): on the column's edge, its glyph in the mark box and its words on the hang, so a run
   of notices reads as one log down a single edge rather than a stack of centred lines of every width.

   ONE LINE, ALWAYS. A notice never wraps and never opens text into the column: a sentence wider than the pane is cut
   with an ellipsis, and everything else it has (the line whole, a provider's or the sandbox's own words, every attempt
   of an incident, the subagent reports a wall turned away, what the model was told for a row nobody typed) is on a card
   a hover raises, or a press on a phone or a keyboard (NoticeCard). On 2026-11-23 seven subagents reporting into one
   disabled account drew seventy lines; the same run is this one row now, its counts beside its words. */

const props = defineProps<{
    message: ChatMessage;
    // The refusal incident this row stands for, the rows before it folded away (chatIncidents.ts).
    incident?: ChatIncident | undefined;
}>();

const t = useT();
const { conversation } = usePaneView();

// The follow-up each notice action offers; each decides for itself whether it still stands. A low-memory hold is not
// here: it draws its whole row (NoticeMemory). `landHold` is only on rows stored before it stopped being offered.
type RowAction = Exclude<NonNullable<ChatMessage["noticeAction"]>, `sendAnyway` | `sandboxMemory` | `landHold`>;
const NOTICE_ACTIONS = {
    depsInstall: NoticeDepsInstall,
    watchStop: NoticeWatchStop,
    sendAgain: NoticeHeld,
    switchModel: NoticeSwitchModel,
} as const satisfies Readonly<Record<RowAction, Component>>;
const noticeAction = computed(() => {
    const action = props.message.noticeAction;
    return action === undefined || action === `sendAnyway` || action === `sandboxMemory` || action === `landHold` ? undefined : NOTICE_ACTIONS[action];
});

// The outside condition this row's wait is about, while it is still armed (AgentSummary.watches), named by id.
const { agentById } = useAgents();
const armedWatch = computed(() => {
    const id = props.message.noticeWaitId;
    return id === undefined ? undefined : agentById(conversation.value.conversationId)?.watches?.find((armed) => armed.id === id);
});

// Wait shown by this notice while running (ChatMessage.noticeWait); undefined once it ends. Each kind is asked of
// whoever owns that wait, since none of them is a field on the row. An instant that may not exist yet: a wait nobody
// owns any more has no clock, which is how a settled row stops ticking without the row itself being rewritten.
type PendingWait = { readonly at: number; readonly counts: "up" | "down" } | undefined;
const clock = (instant: number | undefined, counts: "up" | "down"): PendingWait => (instant === undefined ? undefined : { at: instant, counts });
const pendingWait = computed<PendingWait>(() => {
    switch (props.message.noticeWait) {
        case `credentialRenewal`:
            return clock(conversation.value.failures.credentialRenewal.value?.since, `up`);
        case `chatRoute`:
            return clock(chatRouteWait(conversation.value)?.since, `up`);
        case `watch`:
            // Counts down, like the board's own watch clock: the deadline is the next moment this conversation
            // definitely moves, and how long it has already waited says nothing about that.
            return clock(armedWatch.value?.deadlineAt, `down`);
        default:
            return undefined;
    }
});
// Clock for a pending notice wait only; stops once the wait ends.
const now = useNow(() => pendingWait.value !== undefined);
const waitClock = computed(() => {
    const wait = pendingWait.value;
    if (wait === undefined) {
        return undefined;
    }
    return wait.counts === `up` ? formatElapsed((now.value - wait.at) / 1000) : formatElapsed((wait.at - now.value) / 1000);
});

// What the model was told, for a row nobody at the composer typed: on the card.
const sent = computed(() => props.message.watchWake?.sent ?? props.message.needWake?.sent ?? props.message.agentWords?.sent ?? props.message.agentNotice?.sent);
const turnChecks = computed(() => isTurnChecks(props.message));
const sentKind = computed(() => (props.message.watchWake ? `check` : turnChecks.value ? `findings` : `message`));
// A watch that never saw its condition, or a child that failed, calls for a different next step.
const gaveUp = computed(
    () => (props.message.watchWake !== undefined && props.message.watchWake.outcome !== `met`) || props.message.agentWords?.failed === true,
);
// A notice in the reader's language and words where the row says which one it is (sandboxNotice.ts), else as it was
// written: a sandbox older than this app sends no code, and a newer one may send a code this build does not know. A
// home's lands are committed too, which its landed rows say, and then what they were committed as (NoticeHomeCommit).
const { audience } = useAudience();
const home = computed(() => isHomeConversationId(conversation.value.conversationId));
const homeLand = computed(() => home.value && landOfRow(props.message) !== undefined);
const text = computed(() => noticeLine(props.message, audience.value, { home: home.value }) ?? props.message.text);
// Who said it, when the runtime named an extension: its words are not the sandbox's.
const source = computed(() => (props.message.agentNotice?.source && !turnChecks.value ? props.message.agentNotice.source : undefined));
const line = computed(() => (source.value === undefined ? text.value : `${source.value}: ${text.value}`));
// A failure row: its own glyph, and the provider's or the harness's own words, where it carries any, on the card.
const failure = computed(() => noticeFailure(props.message));
// What a move to another account was made for, in the provider's words: the line names both accounts, the card the why.
const movedFor = computed(() => (props.message.noticeCode?.code === `accountMoved` ? sandboxNoticeOf(props.message) : undefined));
const said = computed(() => failure.value?.said ?? (movedFor.value?.code === `accountMoved` ? movedFor.value.params.said : undefined));
const look = computed(() => agentNoticeLookOf(props.message));
const icon = computed(() => noticeIconOf(props.message, failure.value !== undefined));
// A failure's glyph alone takes the warning colour: the line stays as quiet as every notice, the mark says which kind.
const markTone = computed(() => (failure.value !== undefined && look.value === undefined ? `text-warning` : undefined));

// The counts the line carries for an incident: who reached the wall while it stood, and how often it refused.
const wakes = computed(() => wakeEntries(props.incident?.wakes ?? []));
const tries = computed(() => props.incident?.attempts.length ?? 0);

// Whether the card has anything the line does not: otherwise only a sentence cut short raises it, the line whole.
const behind = computed(() => said.value !== undefined || props.incident !== undefined || sent.value !== undefined);
const words = useTemplateRef<HTMLElement>(`words`);
const cut = (): boolean => words.value !== null && words.value.scrollWidth > words.value.clientWidth + 1;

// Raised by a pointer that stays, and held for one that overshoots onto the card, as the board's stamps are (CardStamps).
const anchor = ref<HTMLElement>();
const hover = useHoverIntent({ open: 350, close: 150, warm: 300 });
const open = computed({
    get: () => hover.shown.value,
    set: (value: boolean) => (value ? hover.show() : hover.hide()),
});
const onEnter = (event: PointerEvent): void => {
    if (event.pointerType === `mouse` && (behind.value || cut())) {
        hover.enter();
    }
};
const onLeave = (): void => hover.leave();
const onCardEnter = (): void => hover.cancel();
// A press is the phone's and the keyboard's way in, and a mouse's way to pin it open or shut it.
const onPress = (): void => {
    open.value = !open.value;
};
</script>

<template>
    <div
        class="chat-meta flex w-full min-w-0 items-center gap-x-2 py-0.5 text-2xs"
        :class="gaveUp ? `text-danger` : (look?.tone ?? `text-subtle`)"
        :data-agent-notice="message.agentNotice?.level"
    >
        <!-- The line: glyph, words cut to one line, the incident's counts and the wait's clock. A press when there is a
             card behind it, else plain words that still raise the card once a narrow pane cuts them short. -->
        <component
            :is="behind ? `button` : `span`"
            ref="anchor"
            :type="behind ? `button` : undefined"
            class="group/line flex min-w-0 items-center gap-x-2 text-left"
            :class="behind && `cursor-pointer`"
            :aria-haspopup="behind ? `dialog` : undefined"
            :aria-expanded="behind ? open : undefined"
            data-notice-line
            @pointerenter="onEnter"
            @pointerleave="onLeave"
            @click="behind && onPress()"
        >
            <!-- Spins and shows the wait's clock while it runs, then settles to a plain line (ChatMessage.noticeWait). -->
            <span v-if="pendingWait" class="chat-mark"><Icon name="spinner" spin class="text-xs text-info" /></span>
            <span v-else class="chat-mark"><Icon :name="icon" class="text-xs" :class="markTone" /></span>
            <span
                ref="words"
                class="min-w-0 truncate decoration-dotted underline-offset-2"
                :class="behind && `group-hover/line:underline`"
                data-notice-words
                ><span v-if="source" class="font-medium">{{ source }}: </span>{{ text }}</span
            >
            <!-- Who reached the wall while it stood, by sender, and how often it refused: counts, the card says who and when. -->
            <span v-if="wakes.length > 0" class="flex shrink-0 items-center gap-1 tabular-nums" data-notice-wakes-count>
                <Icon :name="wakesIcon(wakes)" class="text-2xs" aria-hidden="true" />{{ wakes.length }}
                <span class="sr-only">{{ t(`chat.noticeCard.heldCount`, { count: wakes.length }, wakes.length) }}</span>
            </span>
            <span v-if="tries > 1" class="flex shrink-0 items-center gap-1 tabular-nums" data-notice-tries>
                <Icon name="refresh" class="text-2xs" aria-hidden="true" />{{ tries }}
                <span class="sr-only">{{ t(`chat.incident.attempts`, { count: tries }, tries) }}</span>
            </span>
            <span v-if="waitClock" class="shrink-0 tabular-nums">{{ waitClock }}</span>
        </component>
        <!-- The one follow-up this notice offers, by its action's name (NOTICE_ACTIONS), on the same line. -->
        <component :is="noticeAction" v-if="noticeAction" :message="message" />
        <NoticeHomeCommit v-if="homeLand" :message="message" />
        <AnchoredOverlay v-model="open" :anchor="anchor" side="top" cross="start" :restore-focus="false">
            <div @pointerenter="onCardEnter" @pointerleave="onLeave">
                <NoticeCard
                    :line="line"
                    :icon="icon"
                    :tone="markTone ?? (gaveUp ? `text-danger` : look?.tone)"
                    :lines="message.agentNotice !== undefined"
                    :said="said"
                    :incident="incident"
                    :sent="sent"
                    :sent-kind="sentKind"
                    @close="open = false"
                />
            </div>
        </AnchoredOverlay>
    </div>
</template>
