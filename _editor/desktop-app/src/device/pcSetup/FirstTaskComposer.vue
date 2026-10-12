<script setup lang="ts">
import { Button, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import type { LocalFirstTask } from "@intentic/web/local-host";
import { computed } from "vue";
import type { TaskStart } from "./pcCard";

// THE FIRST TASK, written while this PC is set up and kept by the app until this computer's sandbox can take it
// (first_task.rs): a folder and what to do in it. One heading whatever it shows, which the Agents view it came from
// (2026-10-12) said twice, its step's and its composer's own. Every press is the card's (PcSetupCard.vue), which says
// what the app refused: a folder gone since it was picked, a task with nothing in it.

const props = defineProps<{
    task: LocalFirstTask | undefined;
    /** When it starts, said under it (pcCard.ts `taskStart`). */
    starts: TaskStart;
    /** The card is asking the app something: the presses wait. */
    busy: boolean;
}>();
const emit = defineEmits<{ pick: []; queue: []; edit: []; retry: [] }>();
const folder = defineModel<string>(`folder`, { required: true });
const text = defineModel<string>(`text`, { required: true });

const t = useT();

const kept = computed(() => (props.task?.state === `queued` || props.task?.state === `sending` ? props.task : undefined));
const failed = computed(() => (props.task?.state === `failed` ? props.task : undefined));
const startsLine = computed(() => t(`desktop.pcSetup.task.starts.${props.starts}`));
const ready = computed(() => folder.value !== `` && text.value.trim() !== ``);
</script>

<template>
    <div class="flex flex-col gap-2 border-t border-line pt-3 text-xs">
        <!-- Kept, and waiting for this PC (or a sign-in): what it is, and the way back into it. -->
        <template v-if="kept">
            <div class="flex items-baseline gap-2">
                <h3 class="min-w-0 flex-1 font-medium text-content">{{ t(`desktop.pcSetup.task.keptTitle`) }}</h3>
                <button type="button" :class="ui.textButton({ tone: `quiet`, size: `xs` }, `shrink-0`)" :disabled="busy" @click="emit(`edit`)">
                    {{ t(`desktop.pcSetup.task.edit`) }}
                </button>
            </div>
            <p class="whitespace-pre-line break-words text-content">{{ kept.text }}</p>
            <p class="flex items-center gap-1.5 text-2xs text-subtle">
                <Icon name="folder" class="shrink-0" aria-hidden="true" />
                <span class="min-w-0 truncate font-mono" v-tooltip.top="kept.folder">{{ kept.folder }}</span>
            </p>
            <p class="text-2xs text-muted">{{ kept.state === `sending` ? t(`desktop.pcSetup.task.sending`) : startsLine }}</p>
        </template>

        <!-- It did not start once it could: why, in the app's words, and the same task again. -->
        <template v-else-if="failed">
            <h3 class="font-medium text-content">{{ t(`desktop.pcSetup.task.failedTitle`) }}</h3>
            <p class="whitespace-pre-line break-words text-content">{{ failed.text }}</p>
            <p class="flex items-center gap-1.5 text-2xs text-subtle">
                <Icon name="folder" class="shrink-0" aria-hidden="true" />
                <span class="min-w-0 truncate font-mono" v-tooltip.top="failed.folder">{{ failed.folder }}</span>
            </p>
            <p v-if="failed.reason" class="break-words text-danger">{{ failed.reason }}</p>
            <div class="flex flex-wrap items-center gap-x-4 gap-y-2">
                <Button size="small" :label="t(`ui.action.tryAgain`)" :disabled="busy" @click="emit(`retry`)" />
                <button type="button" :class="ui.textButton({ tone: `quiet`, size: `xs` })" :disabled="busy" @click="emit(`edit`)">
                    {{ t(`desktop.pcSetup.task.edit`) }}
                </button>
            </div>
        </template>

        <!-- Not written yet, or taken back to change. -->
        <template v-else>
            <h3 class="font-medium text-content">{{ t(`desktop.pcSetup.task.title`) }}</h3>
            <p class="-mt-1 text-2xs text-muted">{{ t(`desktop.pcSetup.task.lead`) }} {{ startsLine }}</p>
            <textarea v-model="text" :class="ui.input(`min-h-16 w-full resize-y`)" :placeholder="t(`desktop.pcSetup.task.placeholder`)" />
            <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
                <Button size="small" tier="boring" :label="folder ? t(`desktop.pcSetup.task.changeFolder`) : t(`desktop.pcSetup.task.pickFolder`)" :disabled="busy" @click="emit(`pick`)">
                    <template #icon><Icon name="folder-open" /></template>
                </Button>
                <span v-if="folder" class="min-w-0 flex-1 truncate font-mono text-2xs text-subtle" v-tooltip.top="folder">{{ folder }}</span>
                <span v-else class="flex-1" />
                <Button size="small" :label="t(`desktop.pcSetup.task.queue`)" :disabled="!ready || busy" @click="emit(`queue`)" />
            </div>
        </template>
    </div>
</template>
