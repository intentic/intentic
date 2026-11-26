<script setup lang="ts">
import { formatElapsed, toneInk } from "@intentic/ui";
import { useNow } from "@intentic/ui/async";
import { formatClock } from "@intentic/ui/format";
import { useT } from "@intentic/ui/i18n";
import { sandboxNoticeOf } from "@intentic/sandbox-contract/events/sandbox-notice";
import { isHomeConversationId } from "@intentic/sandbox-contract/ids/conversation-ids";
import { computed, ref, useId, useTemplateRef } from "vue";
import { useAudience } from "../../../../app/useAudience";
import { landOfRow } from "../../../../models/home/homeCommits";
import { usePaneView } from "../../../../models/conversations/panel/useChat-view";
import type { ChatIncident } from "../../../../models/conversations/transcript/chatIncidents";
import { noticeFailure, noticeLine } from "../../../../models/conversations/transcript/sandboxNotice";
import type { ChatMessage } from "../../../../models/conversations/transcript/transcript";
import { wakeEntries, wakesIcon } from "./noticeCard";
import NoticeDetails from "./NoticeDetails.vue";
import NoticeHomeCommit from "./NoticeHomeCommit.vue";
import { noticeActionOf } from "./noticeActions";
import { isTurnChecks } from "./noticeLook";
import NoticeMark from "./NoticeMark.vue";
import { noticePartsOf } from "./noticeParts";
import { useNoticeWait } from "./noticeWait";

/* A NOTICE AS AN EVENT (chat.css `.chat-meta`): one line in one grammar, its mark on the column's edge, then who or what
   it is about, how it ended in its own colour, where or after how long, and when, at the line's end. Whatever else it
   has (the line whole where a narrow pane cut it, a provider's or the sandbox's own words, every attempt of an incident,
   the subagent reports a wall turned away, what the model was told for a row nobody typed) opens in place under it, on
   a press the chevron says is there. Drawn in the column for a wait still running or a press still worth making, and in
   a turn's receipt for everything else (noticeLayout.ts). */

const props = defineProps<{
    message: ChatMessage;
    // The refusal incident this row stands for, the rows before it folded away (chatIncidents.ts).
    incident?: ChatIncident | undefined;
    // Drawn in a list of its own (a turn's receipt): the column's edge is the list's, not this row's.
    listed?: boolean;
    // How the row's one press is drawn: quiet in a list or a line, the strip lights its own.
    actionTier?: `quiet` | `boring`;
}>();

const t = useT();
const { conversation } = usePaneView();
const { audience } = useAudience();

const home = computed(() => isHomeConversationId(conversation.value.conversationId));
const homeLand = computed(() => home.value && landOfRow(props.message) !== undefined);
const parts = computed(() => noticePartsOf(props.message, audience.value, { home: home.value }));
// The whole sentence, which the details repeat where the row cut it.
const line = computed(() => noticeLine(props.message, audience.value, { home: home.value }) ?? props.message.text);

// The one follow-up this notice offers, by its action's name; each decides for itself whether it still stands.
const action = computed(() => noticeActionOf(props.message));

// The wait this row names, while it runs: a spinner for its mark and its clock for its time.
const waitOf = useNoticeWait();
const pending = computed(() => waitOf(props.message));
const now = useNow(() => pending.value !== undefined);
const waitClock = computed(() => {
    const wait = pending.value;
    if (wait === undefined) {
        return undefined;
    }
    return formatElapsed((wait.counts === `up` ? now.value - wait.at : wait.at - now.value) / 1000);
});

// What the model was told, for a row nobody at the composer typed.
const sent = computed(() => props.message.watchWake?.sent ?? props.message.needWake?.sent ?? props.message.agentWords?.sent ?? props.message.agentNotice?.sent);
const turnChecks = computed(() => isTurnChecks(props.message));
const sentKind = computed(() => (props.message.watchWake ? `check` : turnChecks.value ? `findings` : `message`));
// A failure's own words (a provider's, the harness's), or a move to another account's reason, in the provider's words.
const failure = computed(() => noticeFailure(props.message));
const movedFor = computed(() => (props.message.noticeCode?.code === `accountMoved` ? sandboxNoticeOf(props.message) : undefined));
const said = computed(() => failure.value?.said ?? (movedFor.value?.code === `accountMoved` ? movedFor.value.params.said : undefined));

// The counts the line carries for an incident: who reached the wall while it stood, and how often it refused.
const wakes = computed(() => wakeEntries(props.incident?.wakes ?? []));
const tries = computed(() => props.incident?.attempts.length ?? 0);

const time = computed(() => (props.message.openedAt === undefined ? undefined : formatClock(props.message.openedAt)));

// Whether there is anything behind the line: what the details hold, or the sentence a narrow pane cut short.
const behind = computed(() => said.value !== undefined || props.incident !== undefined || sent.value !== undefined);
const subject = useTemplateRef<HTMLElement>(`subject`);
const cut = ref(false);
const measure = (): void => {
    cut.value = subject.value !== null && subject.value.scrollWidth > subject.value.clientWidth + 1;
};
const opens = computed(() => behind.value || cut.value || parts.value.subject !== line.value);
const open = ref(false);
const detailsId = useId();
</script>

<template>
    <div class="flex w-full min-w-0 flex-col" :class="!listed && `chat-meta`" :data-agent-notice="message.agentNotice?.level" data-notice-row>
        <div class="flex min-h-7 w-full min-w-0 items-center gap-x-2 text-2xs">
            <!-- The line: a press when anything is behind it, plain words otherwise. -->
            <component
                :is="opens ? `button` : `div`"
                :type="opens ? `button` : undefined"
                class="group/line -ml-1.5 flex min-h-7 min-w-0 flex-1 items-center gap-x-2 rounded-md pl-1.5 text-left"
                :class="opens && `cursor-pointer hover:bg-overlay/60`"
                :aria-expanded="opens ? open : undefined"
                :aria-controls="opens ? detailsId : undefined"
                data-notice-line
                @pointerenter="measure"
                @focus="measure"
                @click="opens && (open = !open)"
            >
                <span class="chat-mark"><NoticeMark :tone="parts.tone" :icon="parts.icon" :spinning="pending !== undefined" /></span>
                <span
                    ref="subject"
                    class="min-w-0 truncate"
                    :class="parts.tone === `neutral` ? `text-muted` : `font-medium text-content`"
                    :title="cut ? line : undefined"
                    data-notice-words
                    >{{ parts.subject }}</span
                >
                <span v-if="parts.outcome" class="shrink-0 font-medium" :class="toneInk(parts.tone)" data-notice-outcome>{{ parts.outcome }}</span>
                <span v-if="parts.context" class="min-w-0 shrink-[1000] truncate text-subtle" data-notice-context>{{ parts.context }}</span>
                <!-- Who reached the wall while it stood, by sender, and how often it refused: counts, the details say who and when. -->
                <span v-if="wakes.length > 0" class="flex shrink-0 items-center gap-1 text-subtle tabular-nums" data-notice-wakes-count>
                    <Icon :name="wakesIcon(wakes)" class="text-2xs" aria-hidden="true" />{{ wakes.length }}
                    <span class="sr-only">{{ t(`chat.noticeCard.heldCount`, { count: wakes.length }, wakes.length) }}</span>
                </span>
                <span v-if="tries > 1" class="flex shrink-0 items-center gap-1 text-subtle tabular-nums" data-notice-tries>
                    <Icon name="refresh" class="text-2xs" aria-hidden="true" />{{ tries }}
                    <span class="sr-only">{{ t(`chat.incident.attempts`, { count: tries }, tries) }}</span>
                </span>
                <span class="min-w-1 flex-1" />
                <span v-if="waitClock" class="shrink-0 text-subtle tabular-nums" data-notice-clock>{{ waitClock }}</span>
                <span v-else-if="time" class="shrink-0 text-subtle tabular-nums">{{ time }}</span>
                <!-- Every row keeps the chevron's slot, open or not, so the times stand in one column under the header's own
                     chevron instead of an openable row's time stepping left. -->
                <span class="flex w-3 shrink-0 justify-center" data-notice-chevron-slot>
                    <Icon
                        v-if="opens"
                        name="chevron-down"
                        class="text-2xs text-subtle opacity-0 transition group-hover/line:opacity-100 group-focus-visible/line:opacity-100 max-md:opacity-100"
                        :class="open && `rotate-180 opacity-100`"
                        aria-hidden="true"
                    />
                </span>
                <span v-if="opens" class="sr-only">{{ open ? t(`chat.noticeParts.hideDetails`) : t(`chat.noticeParts.showDetails`) }}</span>
            </component>
            <!-- The one follow-up this notice offers, by its action's name (noticeActions.ts), on the same line. -->
            <component :is="action" v-if="action" :message="message" :tier="actionTier ?? `quiet`" />
            <NoticeHomeCommit v-if="homeLand" :message="message" />
        </div>
        <div v-if="open" :id="detailsId" class="pt-1 pb-2 pl-[var(--chat-hang,1.375rem)]">
            <NoticeDetails
                :line="cut || parts.subject !== line ? line : undefined"
                :lines="message.agentNotice !== undefined"
                :said="said"
                :incident="incident"
                :sent="sent"
                :sent-kind="sentKind"
            />
        </div>
    </div>
</template>
