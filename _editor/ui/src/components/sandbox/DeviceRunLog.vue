<!-- A device's live output while it updates, verbatim and unsummarised, plus the tail once it's done. -->
<script setup lang="ts">
import { nextTick, onMounted, ref, watch } from "vue";
import { useT } from "../../i18n/index.js";

const t = useT();

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

const toTail = async (): Promise<void> => {
    await nextTick();
    const element = pane.value;
    if (element !== undefined) {
        element.scrollTop = element.scrollHeight;
    }
};

watch(
    () => props.lines.length,
    async () => {
        if (following.value) {
            await toTail();
        }
    },
);

// A run outlives the pane that draws it, so a revisit mounts on a log that is already long: it opens where the run
// is, not where it started.
onMounted(() => void toTail());
</script>

<template>
    <div class="flex flex-col gap-1">
        <div
            ref="pane"
            class="max-h-48 overflow-auto rounded-lg border border-line bg-canvas p-2 font-mono text-2xs leading-relaxed text-subtle"
            @scroll="onScroll"
        >
            <p v-if="lines.length === 0" class="text-muted">{{ empty ?? t(`ui.deviceRunLog.working`) }}</p>
            <p v-for="(line, index) in lines" :key="index" class="whitespace-pre-wrap break-all">{{ line }}</p>
        </div>
        <p v-if="running && note" class="flex items-center gap-1.5 text-2xs text-muted">
            <Icon name="refresh" spin />
            <span>{{ note }}</span>
        </p>
    </div>
</template>
