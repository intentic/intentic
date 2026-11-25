<script setup lang="ts">
import { sandboxNoticeOf } from "@intentic/sandbox-contract/events/sandbox-notice";
import { formatElapsed, toneDot, toneInk } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, ref, useId } from "vue";
import { useAudience } from "../../../../app/useAudience";
import type { ChatIncident } from "../../../../models/conversations/transcript/chatIncidents";
import type { TurnReceipt } from "../../../../models/conversations/transcript/noticeLayout";
import type { ChatMessage } from "../../../../models/conversations/transcript/transcript";
import { noticePartsOf } from "./noticeParts";
import NoticeRow from "./NoticeRow.vue";

/* A TURN'S RECEIPT: how it went, in one quiet line at its foot, and what happened to its machinery behind the count
   (noticeLayout.ts). Switches, cache, re-reads, rebases, installs and the retries something got past are not lines down
   the column any more; they are here, a press away, each drawn as the event it was (NoticeRow). The line says how the
   turn ended and how long it ran, where its work went, and how many events there were, with a dot when one was a
   problem or a warning. While the turn still runs it shows the count alone: the status line says it is working. */

const props = defineProps<{
    receipt: TurnReceipt;
    // The turn is still being written.
    live: boolean;
    // The refusal incident each drawn row stands for (chatIncidents.ts).
    incidents: ReadonlyMap<number, ChatIncident>;
    home: boolean;
}>();

const t = useT();
const { audience } = useAudience();

const ending = computed(() => {
    if (props.live) {
        return undefined;
    }
    if (props.receipt.stopped) {
        return { icon: `stop` as const, words: t(`chat.noticeReceipt.stopped`) };
    }
    const ms = props.receipt.durationMs;
    return { icon: `check-circle` as const, words: ms === undefined ? t(`chat.noticeReceipt.done`) : t(`chat.noticeReceipt.doneIn`, { elapsed: formatElapsed(ms / 1000) }) };
});

// Where the work went, in a word or two, in the audience's own words: "land" for a developer, "accept" for a maker.
type LandCode = `landed` | `homeLanded` | `landHeld` | `landConflict` | `intoParent` | `intoParentClash`;
const LAND_WORDS = {
    developer: {
        landed: () => t(`chat.noticeReceipt.land.developer.landed`),
        homeLanded: () => t(`chat.noticeReceipt.land.developer.homeLanded`),
        landHeld: () => t(`chat.noticeReceipt.land.developer.landHeld`),
        landConflict: (files: number) => t(`chat.noticeReceipt.land.developer.landConflict`, { count: files }, files),
        intoParent: () => t(`chat.noticeReceipt.land.developer.intoParent`),
        intoParentClash: () => t(`chat.noticeReceipt.land.developer.intoParentClash`),
    },
    maker: {
        landed: () => t(`chat.noticeReceipt.land.maker.landed`),
        homeLanded: () => t(`chat.noticeReceipt.land.maker.homeLanded`),
        landHeld: () => t(`chat.noticeReceipt.land.maker.landHeld`),
        landConflict: (files: number) => t(`chat.noticeReceipt.land.maker.landConflict`, { count: files }, files),
        intoParent: () => t(`chat.noticeReceipt.land.maker.intoParent`),
        intoParentClash: () => t(`chat.noticeReceipt.land.maker.intoParentClash`),
    },
} as const satisfies Readonly<Record<`developer` | `maker`, Readonly<Record<LandCode, (files: number) => string>>>>;
const landWords = (row: ChatMessage): string | undefined => {
    const notice = sandboxNoticeOf(row);
    const words = LAND_WORDS[audience.value];
    switch (notice?.code) {
        case `landed`:
            return props.home || notice.params?.land !== undefined ? words.homeLanded() : words.landed();
        case `landHeld`:
        case `intoParent`:
            return words[notice.code]();
        case `landConflict`:
        case `intoParentClash`:
            return words[notice.code](notice.params.files);
        default:
            return undefined;
    }
};
const land = computed(() => {
    const row = props.receipt.land;
    const words = row === undefined ? undefined : landWords(row);
    return row === undefined || words === undefined ? undefined : { words, tone: noticePartsOf(row, audience.value).tone };
});

const count = computed(() => props.receipt.rows.length);
const mark = computed(() => (props.receipt.problems > 0 ? `danger` : props.receipt.warnings > 0 ? `warning` : undefined));
const marked = computed(() => {
    if (props.receipt.problems > 0) {
        return t(`chat.noticeReceipt.problems`, { count: props.receipt.problems }, props.receipt.problems);
    }
    return props.receipt.warnings > 0 ? t(`chat.noticeReceipt.warnings`, { count: props.receipt.warnings }, props.receipt.warnings) : undefined;
});
const open = ref(false);
const listId = useId();
</script>

<template>
    <div class="chat-meta flex w-full min-w-0 flex-col" data-notice-receipt>
        <div class="flex min-h-7 min-w-0 items-center gap-x-2 text-2xs text-subtle">
            <template v-if="ending">
                <span class="chat-mark"><Icon :name="ending.icon" class="text-xs" :class="ending.icon === `stop` ? `text-subtle` : toneInk(`success`)" /></span>
                <span class="shrink-0 text-muted tabular-nums">{{ ending.words }}</span>
            </template>
            <template v-if="land">
                <span v-if="ending" aria-hidden="true">·</span>
                <span class="min-w-0 truncate font-medium" :class="toneInk(land.tone)" data-notice-receipt-land>{{ land.words }}</span>
            </template>
            <span class="min-w-1 flex-1" />
            <button
                type="button"
                class="-mr-1.5 flex h-6 shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-1.5 transition-colors hover:bg-overlay hover:text-muted"
                :aria-expanded="open"
                :aria-controls="listId"
                data-notice-receipt-count
                @click="open = !open"
            >
                <span v-if="mark" :class="toneDot(mark, `size-1.5 rounded-full`)" aria-hidden="true" />
                <span class="tabular-nums">{{ t(`chat.noticeReceipt.events`, { count }, count) }}</span>
                <span v-if="marked" class="sr-only">{{ marked }}</span>
                <Icon name="chevron-down" class="text-2xs transition" :class="open && `rotate-180`" aria-hidden="true" />
            </button>
        </div>
        <div v-if="open" :id="listId" class="flex flex-col pb-1" data-notice-receipt-list>
            <NoticeRow v-for="row in receipt.rows" :key="row.id" :message="row" :incident="incidents.get(row.id)" listed />
        </div>
    </div>
</template>
