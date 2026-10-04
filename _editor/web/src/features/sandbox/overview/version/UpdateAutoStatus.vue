<!-- Where an update that takes itself stands, beside the update card's button: what it will do and when, what it is
     politely waiting for, and the one answer that applies (not today, not now, resume now). The daemon decides the moment;
     this only says it (autoUpdate.ts) and carries the owner's answer back. Drawn nowhere when automatic updates are off:
     the switch below the card's facts already says so. -->
<script setup lang="ts">
import { Notice, ui } from "@intentic/ui";
import { useAsyncAction, useNow } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { type AutoUpdateAnswer, autoUpdateStatus } from "./autoUpdate";
import { useAutoUpdate } from "./useAutoUpdate";

const t = useT();

const { downloading = false } = defineProps<{
    /** The update on offer is still downloading: the promise is said for once it is in. */
    downloading?: boolean;
}>();

const { auto, canSteer, me, notToday, notNow, resume } = useAutoUpdate();
// Ticks every second only through a countdown; otherwise read by the minute, which is all "until 04:00" needs.
const counting = computed(() => auto.value?.phase === `countdown`);
const clock = useNow(counting);
const status = computed(() => autoUpdateStatus({ auto: auto.value, downloading, me: me.value, now: counting.value ? clock.value : Date.now() }));

const { busy, notice, run } = useAsyncAction();
const ANSWERS = computed(
    (): Record<AutoUpdateAnswer, { label: string; act: () => Promise<void> }> => ({
        "not-today": { label: t(`sandbox.autoUpdate.notToday`), act: notToday },
        "not-now": { label: t(`sandbox.autoUpdate.notNow`), act: notNow },
        resume: { label: t(`sandbox.autoUpdate.resume`), act: resume },
    }),
);
const answer = computed(() => (status.value?.answer === undefined || !canSteer.value ? undefined : ANSWERS.value[status.value.answer]));
const press = (): void => {
    const chosen = answer.value;
    if (chosen !== undefined) {
        void run(chosen.act, t(`sandbox.autoUpdate.couldntChange`));
    }
};

const TONE = { info: `text-link`, progress: `text-primary-500`, paused: `text-subtle`, consent: `text-warning` } as const;

// A promise with nothing to wait on or answer yet (the update is still downloading) is one quiet line, not a panel.
const line = computed(() => {
    const said = status.value;
    return said !== undefined && said.detail === undefined && said.lines.length === 0 && answer.value === undefined && said.failure === undefined;
});
</script>

<template>
    <p v-if="status && line" class="flex items-center gap-1.5 text-2xs text-muted">
        <Icon :name="status.icon" class="shrink-0 text-subtle" aria-hidden="true" />
        <span class="min-w-0">{{ status.title }}</span>
    </p>
    <div v-else-if="status" class="flex flex-col gap-2.5 rounded-lg border border-line-subtle bg-canvas/40 p-3.5" role="status" aria-live="polite">
        <div class="flex items-start gap-2.5">
            <Icon :name="status.icon" :spin="status.spin" class="mt-px shrink-0 text-sm" :class="TONE[status.tone]" aria-hidden="true" />
            <div class="flex min-w-0 flex-1 flex-col gap-1">
                <p class="text-xs font-medium text-content tabular-nums">{{ status.title }}</p>
                <p v-if="status.detail" class="text-2xs text-muted">{{ status.detail }}</p>
            </div>
            <button v-if="answer" type="button" :class="ui.textAction(`shrink-0 text-2xs`)" :disabled="busy" @click="press">
                {{ answer.label }}
            </button>
        </div>
        <!-- What it is waiting for, one line each: the people and the work it will not interrupt. -->
        <ul v-if="status.lines.length > 0" class="flex flex-col gap-1 pl-6" :aria-label="t(`sandbox.autoUpdate.waitingFor`)">
            <li v-for="line in status.lines" :key="line.kind" class="flex items-center gap-1.5 text-2xs text-muted">
                <Icon :name="line.icon" class="shrink-0 text-subtle" aria-hidden="true" />
                <span class="min-w-0">{{ line.text }}</span>
            </li>
        </ul>
        <p v-if="status.failure" class="flex gap-1.5 pl-6 text-2xs text-warning">
            <Icon name="exclamation-triangle" class="mt-px shrink-0" aria-hidden="true" />
            <span class="min-w-0">{{ t(`sandbox.autoUpdate.failure`, { message: status.failure }) }}</span>
        </p>
        <Notice v-if="notice" :of="notice" />
    </div>
</template>
