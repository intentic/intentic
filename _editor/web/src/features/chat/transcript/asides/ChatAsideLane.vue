<script setup lang="ts">
import { computed, ref, useSlots } from "vue";
import type { ChatAsideMark } from "./chatAsides";

// The lane past the reading column, and the marks standing in it: the notes the sandbox prepended, a turn's thinking,
// an errand's own words, a hidden run of tool calls. A glyph and a count is the whole of a mark — its name is on
// hover, its material opens under the bar — so nothing an agent was GIVEN or THOUGHT takes width away from the
// conversation. One bar per row carrying all of that row's marks: two bars in a stack would put their marks half a
// line apart out there, on top of each other.

const props = defineProps<{
    marks: readonly ChatAsideMark[];
    // Which mark stands open until the reader says otherwise; a caller opens material still being written.
    openByDefault?: string;
}>();

// Unset until pressed, so a live mark keeps opening itself; null is the reader having shut everything.
const override = ref<string | null>();
const opened = computed(() => (override.value === undefined ? props.openByDefault : (override.value ?? undefined)));
const toggle = (key: string): void => {
    override.value = opened.value === key ? null : key;
};

// A caller with something to say in the column says it on this bar, so its words and its mark share a line. Such a bar
// keeps its height when opened; an empty one folds to nothing and lets the material take the row.
const slots = useSlots();
const said = computed(() => slots[`default`] !== undefined);
</script>

<template>
    <div v-if="marks.length" class="flex w-full flex-col">
        <!-- Out of flow past the column once there is margin to hold it; a right-aligned row of chips before that. -->
        <div class="chat-mark-bar relative flex w-full items-center justify-end gap-2" :class="opened !== undefined && !said && `chat-mark-bar-open`">
            <slot />
            <div class="chat-mark-lane flex shrink-0 items-center gap-1">
                <button
                    v-for="mark in marks"
                    :key="mark.key"
                    type="button"
                    class="ui-chip min-h-[calc(1lh+0.375rem)] shrink-0 tabular-nums"
                    :class="mark.failed ? `border-danger/40 text-danger` : opened === mark.key && `ui-chip-on`"
                    :aria-expanded="opened === mark.key"
                    :aria-label="mark.label"
                    v-tooltip.left="mark.label"
                    @click="toggle(mark.key)"
                >
                    <!-- Spins only while live: material still filling up is the one thing here worth animating. -->
                    <Icon v-if="mark.busy" name="spinner" spin class="text-2xs" />
                    <Icon v-else :name="mark.icon" class="text-2xs" />
                    <template v-if="mark.count !== undefined">{{ mark.count }}</template>
                </button>
            </div>
        </div>
        <!-- Opened material uses an in-flow transition and remains absent when closed. -->
        <Transition name="chat-mark-reveal">
            <div v-if="opened !== undefined" class="grid">
                <div class="min-h-0 overflow-hidden">
                    <slot :name="opened" />
                </div>
            </div>
        </Transition>
    </div>
</template>
