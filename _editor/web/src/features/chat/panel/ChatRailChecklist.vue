<script setup lang="ts">
import { computed } from "vue";
import { useChat } from "../run/useChat";
import { currentChecklist } from "../transcript/transcript";
import ChatTodoList from "../transcript/ChatTodoList.vue";
import { useT } from "@intentic/ui/i18n";

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
const progress = computed(() => `${done.value} of ${todos.value?.length ?? 0} done`);
</script>

<template>
    <!-- Above plan headroom because this is about now and headroom is about later; both are asides to the transcript. -->
    <section v-if="todos" class="flex max-h-[45%] shrink-0 flex-col gap-2 px-3 pt-3 pb-4" :aria-label="t(`chat.chatRailChecklist.chatsChecklist`)">
        <div class="flex items-baseline gap-1.5">
            <span class="min-w-0 flex-1 truncate text-2xs font-medium text-content">{{ t(`chat.chatRailChecklist.checklist`) }}</span>
            <span class="shrink-0 text-2xs tabular-nums text-subtle" :aria-label="progress">{{ done }}/{{ todos.length }}</span>
        </div>
        <!-- Scrolls on its own so a long list can't push plan headroom off the rail entirely. -->
        <div class="min-h-0 overflow-y-auto">
            <ChatTodoList :todos="todos" :live="live" dense />
        </div>
    </section>
</template>
