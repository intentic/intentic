<script setup lang="ts">
import { DeviceRunLog, Meter, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import { estimatedShare, type WaitExpectation, waitWords } from "./waitProgress";

// A WAIT THAT ENDS BY ITSELF, said in full under the sentence that names it: an estimated bar, how long it has run,
// how long it usually takes, and when the screen stops waiting and offers something to do (waitProgress.ts). The raw
// facts behind the sentence stay behind one press, for a reader who wants them, and are never shown unasked.

const { wait, details = [], what } = defineProps<{
    readonly wait: WaitExpectation;
    // What was observed, verbatim (probe results, the machine's report, the work's own output). Shown only on request.
    readonly details?: readonly string[];
    // What is happening, in one short sentence with a spinner, for a wait that has no sentence of its own above it
    // (a press whose work runs for minutes). A gate or a card that already names the wait leaves this out.
    readonly what?: string | undefined;
}>();

const t = useT();

const share = computed(() => estimatedShare(wait));
const words = computed(() => waitWords(wait));
const open = ref(false);
</script>

<template>
    <div class="flex w-full min-w-0 flex-col gap-1.5 text-left">
        <p v-if="what" class="flex items-start gap-1.5 text-xs text-content">
            <Icon name="spinner" spin class="size-3 shrink-0 text-info" aria-hidden="true" />
            <span>{{ what }}</span>
        </p>
        <Meter v-if="share !== undefined" :value="share" :label="t(`common.waitProgress.estimate`)" :valuetext="words.usual ?? words.elapsed" />
        <p class="flex flex-wrap justify-between gap-x-3 text-2xs text-muted" aria-live="off">
            <span class="tabular-nums">{{ words.elapsed }}</span>
            <span v-if="words.usual">{{ words.usual }}</span>
        </p>
        <p v-if="words.giveUp" class="text-2xs text-subtle">{{ words.giveUp }}</p>
        <template v-if="details.length > 0">
            <button type="button" :class="ui.textButton({ tone: `quiet`, size: `xs` }, `self-start`)" :aria-expanded="open" @click="open = !open">
                <Icon :name="open ? `chevron-down` : `chevron-right`" class="size-3" aria-hidden="true" />
                {{ t(`common.waitProgress.details`) }}
            </button>
            <DeviceRunLog v-if="open" :lines="details" :running="false" />
        </template>
    </div>
</template>
