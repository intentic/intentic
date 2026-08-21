<!-- WHAT A COMPUTER IS SAYING WHILE IT WORKS, and, for a log tail, what it said.
     An update pulls an image and recreates a container: minutes in which the only honest thing a button can do
     is show the machine's own output. The lines are the machine's, verbatim and unsummarised: a step this view
     invented would be a second account of the flow, and the two would drift.
     In the kit because both surfaces that drive a machine's sandboxes render this pane under the row that is
     working: the web's Computers tab and the desktop app's manager window. The one thing that differs between
     them is which computer "there" is, so that sentence is the caller's.
     Follows the tail while it runs, and stops following the moment the reader scrolls up: someone reading an
     error that went past should not be dragged back down by the next line. -->
<script setup lang="ts">
import { nextTick, ref, watch } from "vue";

const props = defineProps<{
    lines: readonly string[];
    running: boolean;
    /** What to say under a pane that is still filling. Absent while nothing runs. */
    note?: string | undefined;
    /** What to say in place of the lines before any have arrived. */
    empty?: string | undefined;
}>();

const pane = ref<HTMLElement | undefined>(undefined);
const following = ref(true);

// "At the bottom" with a few pixels of slack: an exact comparison is false on fractional scroll heights, which is
// most of them at non-integer zoom.
const onScroll = (): void => {
    const element = pane.value;
    if (element !== undefined) {
        following.value = element.scrollHeight - element.scrollTop - element.clientHeight < 24;
    }
};

watch(
    () => props.lines.length,
    async () => {
        if (!following.value) {
            return;
        }
        await nextTick();
        const element = pane.value;
        if (element !== undefined) {
            element.scrollTop = element.scrollHeight;
        }
    },
);
</script>

<template>
    <div class="flex flex-col gap-1">
        <div
            ref="pane"
            class="max-h-48 overflow-auto rounded-lg border border-line bg-canvas p-2 font-mono text-2xs leading-relaxed text-subtle"
            @scroll="onScroll"
        >
            <p v-if="lines.length === 0" class="text-muted">{{ empty ?? `Working…` }}</p>
            <p v-for="(line, index) in lines" :key="index" class="whitespace-pre-wrap break-all">{{ line }}</p>
        </div>
        <p v-if="running && note" class="flex items-center gap-1.5 text-2xs text-muted">
            <Icon name="refresh" spin />
            <span>{{ note }}</span>
        </p>
    </div>
</template>
