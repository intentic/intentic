<script setup lang="ts">
import { agentWordsBody } from "@intentic/sandbox-contract/events/agent-words";
import { Button, Markdown, toneInk, toneWash } from "@intentic/ui";
import { formatClock } from "@intentic/ui/format";
import { useT } from "@intentic/ui/i18n";
import { computed, onMounted, ref, useTemplateRef } from "vue";
import { useAudience } from "../../../../app/useAudience";
import { useAgents } from "../../../../models/fleet/useAgents";
import type { ChatMessage } from "../../../../models/conversations/transcript/transcript";
import { sharedLead, wakeEntries } from "./noticeCard";
import NoticeMark from "./NoticeMark.vue";
import { noticePartsOf } from "./noticeParts";

/* WHAT ARRIVED FOR THE AGENT, drawn as what it is: words from somebody else, signed by their sender (noticeLayout.ts
   `arrival`). A subagent's report leads with its title and how it ended, then what it said, a screenful at most; a fleet
   that reported back to back is one card, its outcomes a ring and one row per sender that opens into that sender's own
   report; a watch that fired is its note and how long it waited. Things that come IN are surfaces; the agent's own
   words stay bare, so the two never read as one voice. It replaced a grey sentence ('Subagent "…" finished on …') and a
   "Show the message" link on a second line (2026-11-25). */

const props = defineProps<{
    // One arrival, or the reports that arrived back to back (ArrivalGroup), oldest first.
    rows: readonly ChatMessage[];
}>();

const t = useT();
const { audience } = useAudience();
const { agentById, open: openAgent } = useAgents();

// SAFETY of `[0]!`: a group or an arrival is never empty (noticeLayout.ts draws a group at its first row).
const head = computed(() => props.rows[0]!);
const grouped = computed(() => props.rows.length > 1);
const partsOf = (row: ChatMessage) => noticePartsOf(row, audience.value);
const clockOf = (row: ChatMessage): string | undefined => (row.openedAt === undefined ? undefined : formatClock(row.openedAt));

// What the other agent said, without the lines the sandbox wraps it in.
const bodyOf = (row: ChatMessage) => (row.agentWords === undefined ? undefined : agentWordsBody(row.agentWords.sent));
const VERIFICATION = {
    verified: { tone: `success`, label: () => t(`chat.noticeArrival.verification.verified`) },
    failing: { tone: `danger`, label: () => t(`chat.noticeArrival.verification.failing`) },
    unproven: { tone: `warning`, label: () => t(`chat.noticeArrival.verification.unproven`) },
    "no-code": { tone: `neutral`, label: () => t(`chat.noticeArrival.verification.noCode`) },
} as const;
const verificationOf = (row: ChatMessage) => {
    const state = bodyOf(row)?.verification;
    return state === undefined ? undefined : VERIFICATION[state];
};
// A report's first line, plain, for its row in a fleet's card.
const gistOf = (row: ChatMessage): string => {
    const said = bodyOf(row)?.said ?? ``;
    const first = said.split(`\n`).find((line) => line.trim() !== ``) ?? ``;
    return first.replace(/^[\s#>*-]+/u, ``).replaceAll(/[*_`]/gu, ``);
};

// The sender's chat, where it is still on the board.
const senderOf = (row: ChatMessage) => (row.agentWords === undefined ? undefined : agentById(row.agentWords.from));
const openSender = (row: ChatMessage): void => {
    const card = senderOf(row);
    if (card !== undefined) {
        openAgent(card, `peek`);
    }
};

// A fleet: its outcomes counted, a name the senders share said once over the rows, and the span they arrived in.
const entries = computed(() => wakeEntries(props.rows));
const lead = computed(() => sharedLead(entries.value));
const failed = computed(() => props.rows.filter((row) => row.agentWords?.failed === true).length);
const finished = computed(() => props.rows.length - failed.value);
const heading = computed(() => {
    const named = lead.value.replace(/[\s:—–/-]+$/u, ``);
    return named === `` ? t(`chat.noticeArrival.reported`, { count: props.rows.length }, props.rows.length) : named;
});
const span = computed(() => {
    const first = clockOf(head.value);
    const last = clockOf(props.rows.at(-1)!);
    return first === last || last === undefined ? first : `${first ?? ``}–${last}`;
});
const nameOf = (row: ChatMessage): string => partsOf(row).subject.slice(lead.value.length);
const openRow = ref<number>();

// A long report is folded to a screenful with a fade; "Show all" opens the rest.
const body = useTemplateRef<HTMLElement>(`body`);
const overflowing = ref(false);
const whole = ref(false);
onMounted(() => {
    overflowing.value = body.value !== null && body.value.scrollHeight > body.value.clientHeight + 1;
});
// A watch's card keeps what the agent was told one press away: its check's own output, the only evidence it fired.
const told = ref(false);
</script>

<template>
    <article class="chat-arrival chat-card w-full" :data-notice-arrival="grouped ? `group` : `single`">
        <!-- A fleet that reported back to back: the ring of outcomes, the name the senders share, the counts and the span. -->
        <template v-if="grouped">
            <header class="chat-card-header items-center text-xs">
                <span class="chat-mark" aria-hidden="true">
                    <!-- One arc per sender, in its outcome's colour, a gap between each: the fleet's verdict before a word. -->
                    <svg viewBox="0 0 20 20" class="size-[1.125rem] -rotate-90">
                        <circle
                            v-for="(row, index) in rows"
                            :key="row.id"
                            cx="10"
                            cy="10"
                            r="7.5"
                            fill="none"
                            stroke-width="3.2"
                            :class="row.agentWords?.failed === true ? `stroke-danger` : `stroke-success`"
                            :stroke-dasharray="`${(47.12 / rows.length - 2.4).toFixed(2)} 47.12`"
                            :stroke-dashoffset="(-index * (47.12 / rows.length)).toFixed(2)"
                        />
                    </svg>
                </span>
                <span class="flex min-w-0 items-center gap-2">
                    <span class="min-w-0 truncate font-semibold text-content">{{ heading }}</span>
                    <span class="shrink-0 text-2xs font-medium" :class="toneInk(`success`)">{{ t(`chat.noticeArrival.finishedCount`, { count: finished }) }}</span>
                    <span v-if="failed > 0" class="shrink-0 text-2xs font-medium" :class="toneInk(`danger`)">{{
                        t(`chat.noticeArrival.failedCount`, { count: failed })
                    }}</span>
                    <span class="min-w-1 flex-1" />
                    <span v-if="span" class="shrink-0 text-2xs text-subtle tabular-nums">{{ span }}</span>
                </span>
            </header>
            <ul class="chat-arrival-rows flex flex-col pb-2">
                <li v-for="row in rows" :key="row.id" data-notice-arrival-row>
                    <button
                        type="button"
                        class="group/row flex min-h-7 w-full min-w-0 items-center gap-2 rounded-md px-1.5 text-left text-2xs hover:bg-overlay/60"
                        :aria-expanded="openRow === row.id"
                        @click="openRow = openRow === row.id ? undefined : row.id"
                    >
                        <NoticeMark :tone="partsOf(row).tone" :icon="partsOf(row).icon" size="sm" />
                        <span class="max-w-[46%] min-w-12 shrink truncate text-content">{{ nameOf(row) }}</span>
                        <span class="min-w-0 flex-1 truncate" :class="row.agentWords?.failed === true ? toneInk(`danger`) : `text-subtle`">{{ gistOf(row) }}</span>
                        <span v-if="partsOf(row).context" class="hidden shrink-0 items-center gap-1 text-subtle @md:flex"
                            ><Icon name="desktop" class="text-2xs" />{{ partsOf(row).context }}</span
                        >
                        <span class="shrink-0 text-subtle tabular-nums">{{ clockOf(row) }}</span>
                        <Icon
                            name="chevron-down"
                            class="shrink-0 text-2xs text-subtle opacity-0 transition group-hover/row:opacity-100 max-md:opacity-100"
                            :class="openRow === row.id && `rotate-180 opacity-100`"
                            aria-hidden="true"
                        />
                    </button>
                    <div v-if="openRow === row.id" class="flex flex-col gap-1.5 pt-1 pb-2 pl-7">
                        <span v-if="verificationOf(row)" class="ui-status-pill self-start" :class="toneWash(verificationOf(row)!.tone)">{{
                            verificationOf(row)!.label()
                        }}</span>
                        <Markdown v-if="bodyOf(row)?.said" :source="bodyOf(row)!.said" class="chat-markdown chat-markdown-compact" />
                        <p v-else class="text-2xs text-subtle">{{ t(`chat.noticeArrival.noReport`) }}</p>
                        <div v-if="senderOf(row)" class="-ml-2 flex">
                            <Button size="small" tier="quiet" @click="openSender(row)">
                                <template #icon><Icon name="arrow-up-right" /></template>{{ t(`chat.noticeCard.openChat`) }}
                            </Button>
                        </div>
                    </div>
                </li>
            </ul>
        </template>

        <!-- One arrival: its sender, how it ended, where, when; then what it said. -->
        <template v-else>
            <header class="chat-card-header items-center text-xs">
                <span class="chat-mark"><NoticeMark :tone="partsOf(head).tone" :icon="partsOf(head).icon" /></span>
                <span class="flex min-w-0 items-center gap-2">
                    <span class="min-w-0 truncate font-semibold text-content" data-notice-words>{{ partsOf(head).subject }}</span>
                    <span v-if="partsOf(head).outcome" class="shrink-0 text-2xs font-medium" :class="toneInk(partsOf(head).tone)">{{ partsOf(head).outcome }}</span>
                    <span v-if="partsOf(head).context" class="min-w-0 shrink-[1000] truncate text-2xs text-subtle">{{ partsOf(head).context }}</span>
                    <span v-if="verificationOf(head)" class="ui-status-pill shrink-0" :class="toneWash(verificationOf(head)!.tone)">{{
                        verificationOf(head)!.label()
                    }}</span>
                    <span class="min-w-1 flex-1" />
                    <span v-if="clockOf(head)" class="shrink-0 text-2xs text-subtle tabular-nums">{{ clockOf(head) }}</span>
                </span>
            </header>
            <div v-if="bodyOf(head) !== undefined" class="chat-card-body pt-0">
                <div ref="body" class="relative overflow-hidden" :class="!whole && `max-h-32`">
                    <Markdown v-if="bodyOf(head)!.said" :source="bodyOf(head)!.said" class="chat-markdown chat-markdown-compact" />
                    <p v-else class="text-2xs text-subtle">{{ t(`chat.noticeArrival.noReport`) }}</p>
                    <span v-if="overflowing && !whole" class="chat-arrival-fade pointer-events-none absolute inset-x-0 bottom-0 h-8" aria-hidden="true" />
                </div>
            </div>
            <pre
                v-if="told && head.watchWake"
                class="chat-card-body chat-inset mx-3 mb-2 max-h-48 overflow-auto py-1.5 text-2xs leading-relaxed whitespace-pre-wrap select-text"
                >{{ head.watchWake.sent }}</pre
            >
            <div v-if="overflowing || senderOf(head) || head.watchWake" class="chat-arrival-actions -mt-1 flex flex-wrap items-center gap-1 pb-2">
                <Button v-if="overflowing" size="small" tier="quiet" :aria-expanded="whole" @click="whole = !whole">
                    {{ whole ? t(`chat.noticeArrival.showLess`) : t(`chat.noticeArrival.showAll`) }}
                </Button>
                <Button v-if="senderOf(head)" size="small" tier="quiet" @click="openSender(head)">
                    <template #icon><Icon name="arrow-up-right" /></template>{{ t(`chat.noticeCard.openChat`) }}
                </Button>
                <Button v-if="head.watchWake" size="small" tier="quiet" :aria-expanded="told" @click="told = !told">
                    {{ t(`chat.noticeCard.sentCheck`) }}
                </Button>
            </div>
        </template>
    </article>
</template>
