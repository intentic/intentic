<script setup lang="ts">
import { Button, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, ref } from "vue";
import type { LocalFirstTask, LocalOnboardingHost } from "../../app/environments/localHost";

const props = defineProps<{
    onboarding: LocalOnboardingHost;
    firstTask: LocalFirstTask | undefined;
    draftFolder: string;
    draftText: string;
    busy: string | undefined;
    /** When the task is queued, shown under the text (varies by PC/sign-in readiness). */
    autoStartHint?: string;
    /** Step 3 description when the composer is shown for editing, not queued. */
    taskDetailHint?: string;
}>();

const emit = defineEmits<{
    "update:draftFolder": [value: string];
    "update:draftText": [value: string];
}>();

const t = useT();
const editing = ref(false);

const folder = computed({
    get: () => props.draftFolder,
    set: (value: string) => emit("update:draftFolder", value),
});
const text = computed({
    get: () => props.draftText,
    set: (value: string) => emit("update:draftText", value),
});

const showQueued = computed(
    () =>
        props.firstTask !== undefined &&
        (props.firstTask.state === `queued` || props.firstTask.state === `sending`) &&
        !editing.value,
);

const pickFolder = async (): Promise<void> => {
    const picked = await props.onboarding.pickFolder();
    if (picked !== undefined) {
        folder.value = picked;
    }
};

const queue = async (): Promise<void> => {
    await props.onboarding.queueFirstTask({ folder: folder.value, text: text.value });
    editing.value = false;
};

const editQueued = async (): Promise<void> => {
    if (props.firstTask === undefined) {
        return;
    }
    folder.value = props.firstTask.folder;
    text.value = props.firstTask.text;
    editing.value = true;
    await props.onboarding.clearFirstTask();
};
</script>

<template>
    <div class="rounded-md border border-line bg-canvas p-3 text-sm">
        <template v-if="showQueued && firstTask">
            <p class="font-medium text-content">{{ t(`local.agents.task.queuedTitle`) }}</p>
            <p class="text-muted">{{ firstTask.folder }}</p>
            <p class="mt-2 text-content">{{ firstTask.text }}</p>
            <p v-if="firstTask.state === `sending`" class="mt-2 text-xs text-muted">{{ t(`local.agents.task.status.sending`) }}</p>
            <p v-else class="mt-2 text-xs text-muted">{{ autoStartHint ?? t(`local.agents.task.autoStart`) }}</p>
            <Button class="mt-2" size="small" tier="boring" :label="t(`local.agents.task.edit`)" :disabled="busy !== undefined" @click="editQueued()" />
        </template>
        <template v-else>
            <p class="font-medium text-content">{{ t(`local.agents.steps.task.title`) }}</p>
            <p class="text-muted">{{ taskDetailHint ?? t(`local.agents.steps.task.detail`) }}</p>
            <div class="mt-3 flex flex-col gap-2">
                <div class="flex flex-wrap gap-2">
                    <Button size="small" tier="boring" :label="t(`local.agents.task.pickFolder`)" :disabled="busy !== undefined" @click="pickFolder()" />
                    <span v-if="folder" class="max-w-full truncate text-xs text-muted">{{ folder }}</span>
                </div>
                <textarea v-model="text" :class="[ui.input(), `min-h-20 w-full resize-y`]" :placeholder="t(`local.agents.task.placeholder`)" />
                <Button
                    size="small"
                    :label="t(`local.agents.task.queue`)"
                    :disabled="!folder || !text.trim() || busy !== undefined"
                    @click="queue()"
                />
            </div>
        </template>
    </div>
</template>
