<script setup lang="ts">
import { Button, formatBytes, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import type { LocalPrefetch } from "@intentic/web/local-host";
import { computed } from "vue";

// THE DOWNLOAD STARTED AT FIRST LAUNCH (onboarding.rs), on the card for this PC's setup: how far, paused or waiting for
// an unmetered connection, with the press that changes that. A failed one says so and offers it again (2026-10-12: it
// used to freeze where it stopped, under a setup that was still running). Nothing before it starts, once it is done, or
// when there was nothing to fetch.

const props = defineProps<{ prefetch: LocalPrefetch | undefined }>();
const emit = defineEmits<{ pause: [paused: boolean]; retry: [] }>();

const t = useT();

const shown = computed(() => {
    const state = props.prefetch?.state;
    return state !== undefined && state !== `idle` && state !== `done` && state !== `skipped`;
});

const amount = computed(() => {
    const row = props.prefetch;
    if (row === undefined || row.total <= 0) {
        return ``;
    }
    if (row.done === 0) {
        return t(`desktop.pcSetup.prefetch.todo`, { total: formatBytes(row.total) });
    }
    return t(`desktop.pcSetup.prefetch.progress`, { done: formatBytes(row.done), total: formatBytes(row.total) });
});

// Why it is not moving, when it is not.
const status = computed((): string | undefined => {
    switch (props.prefetch?.state) {
        case `paused`:
            return t(`desktop.pcSetup.prefetch.paused`);
        case `metered`:
            return t(`desktop.pcSetup.prefetch.metered`);
        case `yielded`:
            return t(`desktop.pcSetup.prefetch.yielded`);
        default:
            return undefined;
    }
});

const percent = computed(() => {
    const row = props.prefetch;
    return row === undefined || row.total <= 0 ? 0 : Math.round((row.done / row.total) * 100);
});
</script>

<template>
    <div v-if="prefetch && shown" class="flex flex-col gap-1.5 text-2xs">
        <template v-if="prefetch.state === `failed`">
            <p class="text-xs text-content">
                {{ t(`desktop.pcSetup.prefetch.failed`) }}
                {{ prefetch.retrying ? t(`desktop.pcSetup.prefetch.retrying`) : t(`desktop.pcSetup.prefetch.later`) }}
            </p>
            <p v-if="prefetch.reason" class="font-mono break-words text-subtle">{{ prefetch.reason }}</p>
            <Button v-if="!prefetch.retrying" class="self-start" size="small" tier="boring" :label="t(`ui.action.tryAgain`)" @click="emit(`retry`)" />
        </template>
        <template v-else>
            <div class="flex items-center gap-3">
                <span class="min-w-0 flex-1 truncate text-subtle">
                    {{ t(`desktop.pcSetup.prefetch.label`) }}<template v-if="amount">: {{ amount }}</template>
                    <template v-if="status"> · {{ status }}</template>
                </span>
                <button
                    v-if="prefetch.state === `running` || prefetch.state === `paused`"
                    type="button"
                    :class="ui.textButton({ tone: `quiet`, size: `xs` }, `shrink-0`)"
                    @click="emit(`pause`, prefetch.state !== `paused`)"
                >
                    {{ prefetch.state === `paused` ? t(`desktop.pcSetup.prefetch.resume`) : t(`desktop.pcSetup.prefetch.pause`) }}
                </button>
                <button
                    v-else-if="prefetch.state === `metered`"
                    type="button"
                    :class="ui.textButton({ tone: `quiet`, size: `xs` }, `shrink-0`)"
                    @click="emit(`pause`, false)"
                >
                    {{ t(`desktop.pcSetup.prefetch.anyway`) }}
                </button>
            </div>
            <div
                class="h-1 overflow-hidden rounded-full bg-line"
                role="progressbar"
                :aria-valuenow="percent"
                aria-valuemin="0"
                aria-valuemax="100"
                :aria-label="t(`desktop.pcSetup.prefetch.label`)"
            >
                <div class="h-full rounded-full bg-primary-500/60 transition-[width] duration-700 ease-smooth" :style="{ width: `${percent}%` }"></div>
            </div>
        </template>
    </div>
</template>
