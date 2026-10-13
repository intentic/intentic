<script setup lang="ts">
import { Button, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import type { LocalFirstTask } from "@intentic/web/local-host";
import { computed } from "vue";
import type { TaskStart } from "./pcCard";

// THE FIRST TASK, written while this PC is set up and kept by the app until this computer's sandbox can take it
// (first_task.rs): a folder and what to do in it. The body of the card's third step (PcStep.vue), whose title is its one
// heading (2026-10-13: it had headings of its own, and the Agents view it came from said one twice). The folder comes
// first, as the place the work happens, then what to do there, then when it starts beside the one press. Every press is
// the card's (PcSetupCard.vue), which says what the app refused: a folder gone since it was picked, a task with nothing
// in it.

const props = defineProps<{
    task: LocalFirstTask | undefined;
    /** When it starts, said beside the press that keeps it (pcCard.ts `taskStart`). */
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
// "Start" only when it would: anything else is kept for later, and the press says so.
const pressLabel = computed(() => (props.starts === `now` ? t(`desktop.pcSetup.task.start`) : t(`desktop.pcSetup.task.queue`)));
</script>

<template>
    <!-- Kept, or did not start: what it is, where, and the way back into it. -->
    <div v-if="kept || failed" class="flex flex-col gap-2 rounded-lg border border-line bg-canvas p-3 text-xs">
        <p class="line-clamp-4 whitespace-pre-line break-words text-content">{{ (kept ?? failed)?.text }}</p>
        <p class="flex items-center gap-1.5 text-2xs text-subtle">
            <Icon name="folder" class="shrink-0" aria-hidden="true" />
            <span class="min-w-0 truncate font-mono" v-tooltip.top="(kept ?? failed)?.folder">{{ (kept ?? failed)?.folder }}</span>
        </p>
        <p v-if="failed?.reason" class="break-words text-danger">{{ failed.reason }}</p>
        <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
            <p v-if="kept" class="flex min-w-0 flex-1 items-center gap-1.5 text-2xs text-muted">
                <Icon :name="kept.state === `sending` ? `spinner` : `clock`" :spin="kept.state === `sending`" class="shrink-0" aria-hidden="true" />
                <span>{{ kept.state === `sending` ? t(`desktop.pcSetup.task.sending`) : startsLine }}</span>
            </p>
            <Button v-else size="small" :label="t(`ui.action.tryAgain`)" :disabled="busy" @click="emit(`retry`)" />
            <button type="button" :class="ui.textButton({ tone: `quiet`, size: `xs` }, `shrink-0`)" :disabled="busy" @click="emit(`edit`)">
                <Icon name="pencil" class="shrink-0" aria-hidden="true" />
                <span>{{ t(`desktop.pcSetup.task.edit`) }}</span>
            </button>
        </div>
    </div>

    <!-- Not written yet, or taken back to change. -->
    <div v-else class="flex flex-col gap-2 text-xs">
        <div class="flex min-w-0 flex-wrap items-center gap-x-3 gap-y-2">
            <Button
                size="small"
                tier="boring"
                :label="folder ? t(`desktop.pcSetup.task.changeFolder`) : t(`desktop.pcSetup.task.pickFolder`)"
                :disabled="busy"
                @click="emit(`pick`)"
            >
                <template #icon><Icon name="folder-open" /></template>
            </Button>
            <span v-if="folder" class="min-w-0 flex-1 truncate font-mono text-2xs text-content" v-tooltip.top="folder">{{ folder }}</span>
            <span v-else class="min-w-0 flex-1 text-2xs text-subtle">{{ t(`desktop.pcSetup.task.noFolder`) }}</span>
        </div>
        <textarea
            v-model="text"
            :class="ui.input(`min-h-20 w-full resize-y`)"
            :aria-label="t(`desktop.pcSetup.task.title`)"
            :placeholder="t(`desktop.pcSetup.task.placeholder`)"
        />
        <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
            <p class="min-w-0 flex-1 text-2xs text-muted">{{ startsLine }}</p>
            <Button size="small" :label="pressLabel" :disabled="!ready || busy" @click="emit(`queue`)">
                <template #icon><Icon name="send" /></template>
            </Button>
        </div>
    </div>
</template>
