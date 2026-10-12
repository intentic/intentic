<script setup lang="ts">
import { Button, formatBytes, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import type { LocalOnboardingHost, LocalPrefetch } from "../../app/environments/localHost";

// The download started at first launch, under the setup card and under the setup's own progress. A failed one says so
// and offers it again (2026-10-12: it used to freeze where it stopped, under a setup that was still running).
const props = defineProps<{
    prefetch: LocalPrefetch | undefined;
    onboarding: LocalOnboardingHost | undefined;
}>();

const t = useT();

// Nothing to draw before it starts, once it is done, or when there was nothing to fetch.
const shown = computed(() => {
    const state = props.prefetch?.state;
    return state !== undefined && state !== `idle` && state !== `done` && state !== `skipped`;
});

const line = computed(() => {
    const row = props.prefetch;
    if (row === undefined || row.total <= 0) {
        return ``;
    }
    if (row.done === 0) {
        return t(`local.agents.prefetch.todo`, { total: formatBytes(row.total) });
    }
    return t(`local.agents.prefetch.progress`, { done: formatBytes(row.done), total: formatBytes(row.total) });
});

const status = computed((): string | undefined => {
    switch (props.prefetch?.state) {
        case `paused`:
            return t(`local.agents.prefetch.paused`);
        case `metered`:
            return t(`local.agents.prefetch.meteredWait`);
        case `yielded`:
            return t(`local.agents.prefetch.yielded`);
        default:
            return undefined;
    }
});

const width = computed(() => {
    const row = props.prefetch;
    return row === undefined || row.total <= 0 ? 0 : (row.done / row.total) * 100;
});
</script>

<template>
    <div v-if="prefetch && shown" class="space-y-1 text-xs text-muted">
        <template v-if="prefetch.state === `failed`">
            <p class="text-sm text-content">
                {{ t(`local.agents.prefetch.failed`) }}
                {{ prefetch.retrying ? t(`local.agents.prefetch.retrying`) : t(`local.agents.prefetch.later`) }}
            </p>
            <p v-if="prefetch.reason" class="break-words">{{ prefetch.reason }}</p>
            <Button
                v-if="onboarding?.retryPrefetch"
                class="mt-1"
                size="small"
                tier="boring"
                :label="t(`local.agents.prefetch.retry`)"
                @click="onboarding.retryPrefetch()"
            />
        </template>
        <template v-else>
            <div class="flex flex-wrap items-center gap-2">
                <span>{{ t(`local.agents.prefetch.label`) }}: {{ line }}</span>
                <span v-if="status">{{ status }}</span>
            </div>
            <div class="flex flex-wrap items-center gap-2">
                <div class="h-1 min-w-32 flex-1 overflow-hidden rounded-full bg-line">
                    <div
                        class="h-full rounded-full bg-primary-500 transition-[width] duration-700 ease-smooth"
                        :style="{ width: `${width}%` }"
                    ></div>
                </div>
                <button
                    v-if="prefetch.state === `running` || prefetch.state === `paused`"
                    type="button"
                    :class="ui.textButton({ tone: `subtle`, size: `xs` })"
                    @click="onboarding?.pause(prefetch.state !== `paused`)"
                >
                    {{ prefetch.state === `paused` ? t(`local.agents.prefetch.resume`) : t(`local.agents.prefetch.pause`) }}
                </button>
                <button
                    v-if="prefetch.state === `metered`"
                    type="button"
                    :class="ui.textButton({ tone: `subtle`, size: `xs` })"
                    @click="onboarding?.pause(false)"
                >
                    {{ t(`local.agents.prefetch.anyway`) }}
                </button>
            </div>
        </template>
    </div>
</template>
