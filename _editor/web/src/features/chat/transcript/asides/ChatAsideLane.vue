<script setup lang="ts">
import { computed, ref, useSlots } from "vue";
import type { ChatAsideMark } from "./chatAsides";

// The lane past the reading column, and the marks standing in it: the notes the sandbox prepended to a message, an
// errand's own words. A glyph and a count is the whole of a mark — its name is on hover, its material opens under the
// bar — so nothing an agent was GIVEN takes width away from the conversation. What it THOUGHT and RAN is not here: that
// stands on the spine down the column's other edge (ChatTurnAsides). One bar per row carrying all of that row's marks:
// two bars in a stack would put their marks half a line apart out there, on top of each other.

const props = defineProps<{
    marks: readonly ChatAsideMark[];
}>();

// Which mark stands open; one at a time, since they share the one place under the bar.
const opened = ref<string>();
// The mark find-in-page opened: shown at once, since the browser scrolls to the match before a fold would finish.
const found = ref<string>();
const toggle = (key: string): void => {
    found.value = undefined;
    opened.value = opened.value === key ? undefined : key;
};
const onFound = (key: string): void => {
    found.value = key;
    opened.value = key;
};

const findable = computed(() => props.marks.filter((mark) => mark.findable === true));

// A caller with something to say in the column says it on this bar, so its words and its mark share a line. Such a bar
// keeps its height when opened; an empty one folds to nothing and lets the material take the row.
const slots = useSlots();
const said = computed(() => slots[`default`] !== undefined);
</script>

<template>
    <!-- `chat-mark-open` is what makes the bar stick to its own material: the chip that opened a long run has to stay
         pressable at the end of it (chat.css). -->
    <div v-if="marks.length" class="flex w-full flex-col" :class="opened !== undefined && `chat-mark-open`">
        <!-- Out of flow past the column once there is margin to hold it; a right-aligned row of chips before that. -->
        <div class="chat-mark-bar relative flex w-full items-center justify-end gap-2" :class="opened !== undefined && !said && `chat-mark-bar-open`">
            <slot />
            <div class="chat-mark-lane flex shrink-0 items-center gap-1">
                <button
                    v-for="mark in marks"
                    :key="mark.key"
                    type="button"
                    class="ui-chip min-h-[calc(1lh+0.375rem)] shrink-0 tabular-nums"
                    :class="opened === mark.key && `ui-chip-on`"
                    :aria-expanded="opened === mark.key"
                    :aria-label="mark.label"
                    v-tooltip.left="mark.tip ?? mark.label"
                    @click="toggle(mark.key)"
                >
                    <Icon :name="mark.icon" class="text-2xs" />
                    <template v-if="mark.count !== undefined">{{ mark.count }}</template>
                </button>
            </div>
        </div>
        <!-- Other material fades in where it lands (chat-mark-reveal) and is absent when closed. -->
        <Transition name="chat-mark-reveal">
            <div v-if="opened !== undefined && !findable.some((mark) => mark.key === opened)" class="grid">
                <div class="min-h-0 overflow-hidden">
                    <slot :name="opened" />
                </div>
            </div>
        </Transition>
        <!-- One node open or shut: beforematch reveals the element it fired on, and a swapped-in copy would lose the match. -->
        <div
            v-for="mark in findable"
            :key="mark.key"
            class="chat-mark-material"
            :class="found === mark.key && `chat-mark-found`"
            :hidden.attr="opened === mark.key ? undefined : `until-found`"
            @beforematch="onFound(mark.key)"
        >
            <div class="min-h-0 overflow-hidden">
                <slot :name="mark.key" />
            </div>
        </div>
    </div>
</template>
