<script setup lang="ts">
import { useRowReveal } from "@intentic/ui/motion";
import { computed, ref } from "vue";
import { useChat } from "../../../models/conversations/run/useChat";
import { currentChecklist } from "../../../models/conversations/transcript/transcript";
import ChatTodoList from "../transcript/ChatTodoList.vue";
import { useT } from "@intentic/ui/i18n";
import { uiLength } from "../../../workbench/window/uiScale";
import { CAPACITY_RAIL_PX } from "./capacity/chatCapacity";
import { useChecklistSpread } from "./railChecklistSpread";

// The focused chat's checklist where it can stay put. The transcript records each snapshot at the point it happened,
// which answers "what changed, and when" but never "what is left" without scrolling; a list is state, and state wants
// a surface that persists. Follows the focused conversation, not the pane set: a split draws two transcripts, but the
// reader is typing into one.

const t = useT();

const { active } = useChat();

const todos = computed(() => currentChecklist(active.value.transcript.messages.value));
// `generating`, not `streaming`: a turn parked on a permission card is waiting on the reader, so nothing should spin.
const live = computed(() => active.value.turn.generating.value);
const done = computed(() => todos.value?.filter((item) => item.status === `completed`).length ?? 0);
const progress = computed(() => t(`chat.chatRailChecklist.progress`, { done: done.value, total: todos.value?.length ?? 0 }));

// THE ITEMS ARRIVE TOP TO BOTTOM, as the lanes beside it do (reveal.ts): when the checklist shows, and again for another
// chat's list (the section is keyed by the chat, so its rows are new), and an item the agent adds later plays in on
// its own at the foot, which is where the eye should go: the plan just grew.
const section = ref<HTMLElement>();
useRowReveal(section, { key: () => `${active.value.conversationId}:${todos.value?.length ?? 0}`, arrivals: true });

// A LIST TOO LONG FOR ITS SHARE OF THE RAIL SPREADS LEFT into a second column, where the panel has room nothing else
// uses (railChecklistSpread.ts). It reaches past the rail's box instead of widening it, so the reserved width and the
// transcript beside it hold still; plan headroom below keeps its own width.
const list = ref<HTMLElement>();
const spread = useChecklistSpread(section, list, () =>
    // The rows' text, not just their count: an item renamed or started can wrap to another line.
    `${active.value.conversationId}:${todos.value?.map((item) => `${item.status}:${item.content}:${item.activeForm ?? ``}`).join(`\n`) ?? ``}:${live.value}`,
);
</script>

<template>
    <!-- Above plan headroom because this is about now and headroom is about later; both are asides to the transcript. -->
    <section
        v-if="todos"
        ref="section"
        :key="active.conversationId"
        class="flex min-h-0 flex-col gap-2 px-3 pt-3 pb-4"
        :style="spread ? { marginLeft: `calc(-1 * ${uiLength(CAPACITY_RAIL_PX)})` } : undefined"
        :aria-label="t(`chat.chatRailChecklist.chatsChecklist`)"
    >
        <div class="flex items-baseline gap-1.5">
            <span class="min-w-0 flex-1 truncate text-2xs font-medium text-content">{{ t(`chat.chatRailChecklist.checklist`) }}</span>
            <span class="shrink-0 text-2xs tabular-nums text-subtle" :aria-label="progress">{{ done }}/{{ todos.length }}</span>
        </div>
        <!-- Scrolls on its own only once the rail runs out of height (ChatSideRail shares it out), so a long list can't
             push plan headroom off the rail entirely. Spread, it scrolls only if two columns still don't fit. -->
        <div ref="list" class="min-h-0 overflow-y-auto">
            <ChatTodoList :todos="todos" :live="live" dense :spread="spread" />
        </div>
    </section>
</template>
