<script setup lang="ts">
import type { TranscriptChildNews } from "@intentic/sandbox-contract/events/transcript";
import { Button, toneDot, toneInk, toneRim } from "@intentic/ui";
import { formatClock } from "@intentic/ui/format";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import type { ChatMessage } from "../../../../models/conversations/transcript/transcript";
import { useAgents } from "../../../../models/fleet/useAgents";
import { boardRoute } from "../../../../models/sandbox/devices/deviceLinks";
import { newsBlock, newsLabel, newsTone } from "./newsLines";

/* NEWS ABOUT SUBAGENTS on the owner's own edge (newsLines.ts says why): a rail in the loudest tone among the lines, a
   heading over more than one, a line per subagent that opens into exactly what the agent was told, and the cause they
   share said once, with the way to where it is fixed. No bubble, no card: it is the sandbox speaking to the agent, and
   the owner reads it only when they want to. */

const props = defineProps<{
    // One piece of news, or news that arrived back to back (noticeLayout.ts ArrivalGroup), oldest first.
    rows: readonly ChatMessage[];
}>();

const t = useT();
const router = useRouter();
const { agentById, open: openAgent } = useAgents();

interface Line {
    readonly row: ChatMessage;
    readonly news: TranscriptChildNews;
}

const lines = computed((): Line[] => props.rows.flatMap((row) => (row.childNews === undefined ? [] : [{ row, news: row.childNews }])));
const block = computed(() => newsBlock(lines.value.map((line) => line.news)));
const single = computed(() => lines.value.length === 1);

// A subagent by its title: the news's own where the sentence named one, else its card's, else its id.
const nameOf = (news: TranscriptChildNews): string => news.title ?? agentById(news.from)?.title ?? news.from;
const clockOf = (row: ChatMessage): string | undefined => (row.openedAt === undefined ? undefined : formatClock(row.openedAt));
const span = computed(() => {
    const first = lines.value[0];
    const last = lines.value.at(-1);
    const from = first === undefined ? undefined : clockOf(first.row);
    const to = last === undefined ? undefined : clockOf(last.row);
    return from === to || to === undefined ? from : `${from ?? ``}–${to}`;
});

const open = ref<number>();
const openSender = (news: TranscriptChildNews): void => {
    const card = agentById(news.from);
    if (card !== undefined) {
        openAgent(card, `peek`);
    }
};
const openDevices = (): void => {
    void router.push(boardRoute());
};
</script>

<template>
    <!-- A definite width (a prompt's 85%, capped for a wide column), so a line's share between name and label resolves. -->
    <section class="ml-auto flex w-full max-w-[min(85%,36rem)] min-w-0 flex-col border-r-2 pr-2.5" :class="toneRim(block.tone)" data-notice-news>
        <header v-if="block.heading" class="flex min-w-0 items-baseline gap-1.5 px-1.5 pb-0.5 text-xs text-subtle">
            <span aria-hidden="true">↳</span>
            <!-- Wraps rather than cuts: its end ("from omen") is the part worth reading on a phone. -->
            <span class="line-clamp-2 min-w-0 font-medium text-content">{{ block.heading }}</span>
            <span class="min-w-2 flex-1" />
            <span v-if="span" class="shrink-0 text-2xs tabular-nums">{{ span }}</span>
        </header>
        <ul class="flex min-w-0 flex-col">
            <li v-for="line in lines" :key="line.row.id" class="min-w-0" data-notice-news-line>
                <button
                    type="button"
                    class="group/line flex min-h-6 w-full min-w-0 items-center gap-2 rounded-md px-1.5 text-left text-xs hover:bg-overlay/60"
                    :aria-expanded="open === line.row.id"
                    @click="open = open === line.row.id ? undefined : line.row.id"
                >
                    <span :class="toneDot(newsTone(line.news), `size-1.5 shrink-0 rounded-full`)" aria-hidden="true" />
                    <!-- Name and label share one line where they fit, and the label drops under the name where they
                         do not: on a phone, one line left "#." of the name beside the label. -->
                    <span class="flex min-w-0 flex-1 flex-wrap items-baseline gap-x-2">
                        <span class="max-w-full min-w-0 truncate text-content/85">{{ nameOf(line.news) }}</span>
                        <span v-if="!block.shared" class="ml-auto max-w-full min-w-0 truncate text-2xs text-subtle">{{ newsLabel(line.news) }}</span>
                    </span>
                    <span v-if="single && clockOf(line.row)" class="shrink-0 text-2xs text-subtle tabular-nums">{{ clockOf(line.row) }}</span>
                    <Icon
                        name="chevron-down"
                        class="shrink-0 text-3xs text-subtle opacity-0 transition group-hover/line:opacity-100 max-md:opacity-100"
                        :class="open === line.row.id && `rotate-180 opacity-100`"
                        aria-hidden="true"
                    />
                </button>
                <div v-if="open === line.row.id" class="flex flex-col gap-1 pt-0.5 pb-1.5 pl-5">
                    <span class="text-2xs text-subtle">{{ t(`chat.noticeNews.told`) }}</span>
                    <pre class="chat-inset max-h-48 overflow-auto rounded-md px-2.5 py-1.5 text-2xs leading-relaxed whitespace-pre-wrap select-text">{{
                        line.news.sent
                    }}</pre>
                    <div v-if="agentById(line.news.from)" class="-ml-2 flex">
                        <!-- `:label`, never words in the default slot beside `#icon` (NoticeArrival.vue says why). -->
                        <Button size="small" tier="quiet" :label="t(`chat.noticeCard.openChat`)" @click="openSender(line.news)">
                            <template #icon><Icon name="arrow-up-right" /></template>
                        </Button>
                    </div>
                </div>
            </li>
        </ul>
        <div v-if="block.cause || block.devices" class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5 px-1.5 pt-0.5 text-2xs">
            <span v-if="block.cause" class="line-clamp-2 min-w-0" :class="toneInk(block.tone)">{{ block.cause }}</span>
            <Button v-if="block.devices" size="small" tier="quiet" :label="t(`chat.noticeNews.openDevices`)" @click="openDevices">
                <template #icon><Icon name="arrow-up-right" /></template>
            </Button>
        </div>
    </section>
</template>
