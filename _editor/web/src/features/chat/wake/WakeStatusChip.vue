<script setup lang="ts">
import { Icon } from "@intentic/ui";
import { useNow } from "@intentic/ui/async";
import { computed } from "vue";
import { useRouter } from "vue-router";
import { useWakeListener } from "../../../models/voice/useWakeListener";
import { wakeStatus } from "../../../models/voice/wakeStatus";
import { settingsPartPath } from "../../settings/settingsNav";

// The wake word's place in the desktop status bar, while listening is switched on for this device: what it listens for,
// that it is paused and until when, or what stops it. A press pauses it for an hour, brings it back, or opens the Voice
// settings where a stop is fixed. Drawn only where the shell draws the bar.

const listener = useWakeListener();
const router = useRouter();
const now = useNow(computed(() => listener.pausedUntil.value !== undefined), 30_000);
const status = computed(() => wakeStatus(listener, now.value));

const press = (): void => {
    switch (status.value?.press) {
        case `pause`:
            listener.pause(60);
            return;
        case `resume`:
            listener.resume();
            return;
        case `settings`:
            void router.push(settingsPartPath(`voice`));
            return;
        case `none`:
        case undefined:
            return;
    }
};
</script>

<template>
    <button
        v-if="status !== undefined"
        type="button"
        data-chip="wake"
        class="flex h-6 min-w-0 shrink-0 items-center gap-1.5 rounded-md px-1.5 transition-colors hover:bg-content/5"
        :class="status.tone === `warning` ? `text-warning` : status.tone === `active` ? `text-content` : `text-muted hover:text-content`"
        :aria-label="status.detail"
        v-tooltip.top="status.detail"
        @click="press"
    >
        <Icon :name="status.icon" class="shrink-0 text-xs" :class="{ 'text-primary-500': status.tone === `active` }" />
        <span class="truncate">{{ status.label }}</span>
    </button>
</template>
