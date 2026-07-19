<script setup lang="ts">
import { StatusBadge } from "@intentic-app/ui";
import Button from "primevue/button";
import { ref } from "vue";
import { sandboxLogs, type SandboxStatus } from "../desktop";

const props = defineProps<{
    sandbox: SandboxStatus;
    busy: string | null;
}>();

const emit = defineEmits<{
    start: [slug: string];
    stop: [slug: string];
    update: [slug: string];
    remove: [slug: string];
}>();

const logs = ref<string | undefined>(undefined);
const logsOpen = ref(false);

const toggleLogs = async (): Promise<void> => {
    logsOpen.value = !logsOpen.value;
    if (logsOpen.value) {
        logs.value = await sandboxLogs(props.sandbox.slug, 200).catch((error: unknown) => String(error));
    }
};
</script>

<template>
    <div class="flex flex-col gap-3 rounded-xl border border-line bg-canvas p-4">
        <div class="flex items-center gap-3">
            <Icon name="box" class="shrink-0 text-info" />
            <div class="flex min-w-0 flex-1 flex-col">
                <span class="truncate text-sm font-semibold text-content">{{ sandbox.name ?? sandbox.slug }}</span>
                <span class="truncate font-mono text-2xs text-subtle">{{ sandbox.url ?? sandbox.container }}</span>
            </div>
            <StatusBadge :variant="sandbox.running ? `success` : `neutral`" :label="sandbox.running ? `running` : `stopped`" />
            <StatusBadge
                v-if="sandbox.tunnelRunning !== null"
                :variant="sandbox.tunnelRunning ? `success` : `warning`"
                :label="sandbox.tunnelRunning ? `tunnel` : `tunnel off`"
            />
        </div>
        <div class="flex flex-wrap items-center gap-2">
            <Button
                v-if="!sandbox.running"
                size="small"
                label="Start"
                :loading="busy === `start`"
                :disabled="busy !== null"
                @click="emit(`start`, sandbox.slug)"
            />
            <Button
                v-else
                size="small"
                severity="secondary"
                label="Stop"
                :loading="busy === `stop`"
                :disabled="busy !== null"
                @click="emit(`stop`, sandbox.slug)"
            />
            <Button
                size="small"
                severity="secondary"
                label="Update"
                :loading="busy === `update`"
                :disabled="busy !== null"
                @click="emit(`update`, sandbox.slug)"
            />
            <Button size="small" severity="secondary" :label="logsOpen ? `Hide logs` : `Logs`" :disabled="busy !== null" @click="toggleLogs" />
            <Button
                size="small"
                severity="danger"
                :text="true"
                label="Remove"
                class="ml-auto"
                :loading="busy === `remove`"
                :disabled="busy !== null"
                @click="emit(`remove`, sandbox.slug)"
            />
        </div>
        <pre
            v-if="logsOpen"
            class="max-h-56 overflow-auto rounded-lg border border-line bg-surface p-2 font-mono text-2xs leading-relaxed whitespace-pre-wrap text-muted"
            >{{ logs ?? `Loading…` }}</pre>
    </div>
</template>
