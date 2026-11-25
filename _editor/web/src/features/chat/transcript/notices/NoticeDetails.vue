<script setup lang="ts">
import { CopyButton, SectionHeader } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { useAgents } from "../../../../models/fleet/useAgents";
import type { ChatIncident } from "../../../../models/conversations/transcript/chatIncidents";
import { attemptTimes, cardCopy, otherWords, sharedLead, type WakeEntry, type WakeState, wakeEntries } from "./noticeCard";
import NoticeFailureDetails from "./NoticeFailureDetails.vue";

/* WHAT A NOTICE KEEPS BEHIND ITS ONE LINE, opened in place under it (NoticeRow, NoticeStrip): the line whole where the
   row cut it, somebody else's words quoted (a provider's refusal, the sandbox's own paragraph), who the wall turned away
   while it stood, when it refused, and what the agent was told for a row nobody typed. Each part is a heading and a few
   short rows, never a paragraph of ours. It used to be a card a hover raised, which nothing on the row said was there. */

const props = defineProps<{
    // The row's sentence, given only where the row cut it short.
    line?: string | undefined;
    // The row keeps its line breaks (a runtime extension's notice).
    lines?: boolean;
    said?: string | undefined;
    incident?: ChatIncident | undefined;
    sent?: string | undefined;
    sentKind?: `check` | `findings` | `message`;
}>();

const t = useT();

// The words quoted: the row's own, else the last refusal's for a row standing for an incident that has none (a re-send
// in flight drawn as its latest word).
const quoted = computed(() => props.said ?? props.incident?.attempts.at(-1)?.said);
const reworded = computed(() => (props.incident === undefined ? [] : otherWords(props.incident, quoted.value)));
const times = computed(() => (props.incident === undefined ? [] : attemptTimes(props.incident)));
const tries = computed(() => props.incident?.attempts.length ?? 0);
const wakes = computed(() => wakeEntries(props.incident?.wakes ?? []));
// A lead every sender's name shares ("Optimizations slice: ") goes over the list once, so each row is its own name.
const lead = computed(() => sharedLead(wakes.value));
const heldHeading = computed(() => {
    const count = wakes.value.length;
    const from = lead.value.replace(/[\s:—–/-]+$/u, ``);
    return from === `` ? t(`chat.noticeCard.held`, { count }) : t(`chat.noticeCard.heldFrom`, { count, from });
});

const STATE_WORDS = {
    failed: () => t(`chat.noticeCard.state.failed`),
    finished: () => t(`chat.noticeCard.state.finished`),
    message: () => t(`chat.noticeCard.state.message`),
    fired: () => t(`chat.noticeCard.state.fired`),
    gaveUp: () => t(`chat.noticeCard.state.gaveUp`),
    given: () => t(`chat.noticeCard.state.given`),
    declined: () => t(`chat.noticeCard.state.declined`),
} as const satisfies Readonly<Record<WakeState, () => string>>;
// Only an ending that calls for a different next step takes ink.
const LOUD: ReadonlySet<WakeState> = new Set([`failed`, `gaveUp`, `declined`]);

const SENT_HEADINGS = {
    check: () => t(`chat.noticeCard.sentCheck`),
    findings: () => t(`chat.noticeCard.sentFindings`),
    message: () => t(`chat.noticeCard.sentMessage`),
} as const;

const copied = computed(() => cardCopy({ line: props.line ?? ``, said: quoted.value, incident: props.incident, sent: props.sent }));

// Another agent's entry opens its chat beside this one.
const { agentById, open: openAgent } = useAgents();
const openable = (entry: WakeEntry): boolean => entry.agentId !== undefined && agentById(entry.agentId) !== undefined;
const openEntry = (entry: WakeEntry): void => {
    const card = entry.agentId === undefined ? undefined : agentById(entry.agentId);
    if (card !== undefined) {
        openAgent(card, `peek`);
    }
};
</script>

<template>
    <div class="relative flex flex-col gap-3 pr-7 text-2xs leading-relaxed" data-notice-details>
        <!-- Everything below as text, for a bug report or a support ticket, in reach however far its parts run. -->
        <CopyButton :text="copied" :aria-label="t(`chat.failure.copyDetails`)" v-tooltip.top="t(`chat.failure.copyDetails`)" class="absolute -top-1 right-0" />

        <p v-if="line" class="text-xs leading-snug break-words text-content" :class="{ 'whitespace-pre-line': lines }">{{ line }}</p>

        <NoticeFailureDetails v-if="quoted !== undefined" :said="quoted" />

        <!-- Who reached the wall while it stood: one row per sender, however often its words were sent again. -->
        <section v-if="wakes.length > 0" class="flex flex-col" data-notice-wakes>
            <SectionHeader :label="heldHeading" density="dense" class="px-0 py-0.5" />
            <ul class="-mx-1.5 flex max-h-48 flex-col overflow-auto">
                <li v-for="entry in wakes" :key="entry.key">
                    <component
                        :is="openable(entry) ? `button` : `div`"
                        :type="openable(entry) ? `button` : undefined"
                        class="flex w-full min-w-0 items-center gap-2 rounded-md px-1.5 py-1 text-left"
                        :class="openable(entry) && `cursor-pointer hover:bg-overlay`"
                        :aria-label="openable(entry) ? `${entry.label} · ${t(`chat.noticeCard.openChat`)}` : undefined"
                        data-notice-wake
                        @click="openEntry(entry)"
                    >
                        <Icon :name="entry.icon" class="shrink-0 text-xs text-subtle" />
                        <span class="min-w-0 flex-1 truncate text-content">{{ entry.label.slice(lead.length) }}</span>
                        <span v-if="entry.count > 1" class="shrink-0 text-subtle tabular-nums">×{{ entry.count }}</span>
                        <span class="shrink-0" :class="LOUD.has(entry.state) ? `text-danger` : `text-subtle`">{{ STATE_WORDS[entry.state]() }}</span>
                    </component>
                </li>
            </ul>
        </section>

        <!-- When it refused: a count and the clocks, and any other words a refusal was reworded in mid-run. -->
        <div v-if="tries > 1" class="flex flex-col gap-1" data-incident-attempts>
            <p class="flex min-w-0 items-center gap-2">
                <Icon name="refresh" class="shrink-0 text-xs text-subtle" />
                <span class="shrink-0 text-content">{{ t(`chat.incident.attempts`, { count: tries }, tries) }}</span>
                <span class="min-w-0 truncate text-subtle tabular-nums">{{ times.join(` · `) }}</span>
            </p>
            <p v-for="words in reworded" :key="words" class="border-l-2 border-line pl-2.5 break-words text-muted select-text">{{ words }}</p>
        </div>

        <!-- What the model was told for a row nobody typed, verbatim: the evidence for a line no person wrote. -->
        <section v-if="sent !== undefined" class="flex flex-col gap-1" data-notice-sent>
            <SectionHeader :label="SENT_HEADINGS[sentKind ?? `message`]()" density="dense" class="px-0 py-0.5" />
            <pre class="max-h-48 overflow-auto rounded-md bg-canvas px-2 py-1.5 text-2xs leading-relaxed whitespace-pre-wrap text-muted select-text">{{ sent }}</pre>
        </section>
    </div>
</template>
