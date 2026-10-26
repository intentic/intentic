<script setup lang="ts">
import { Button, Notice, ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import type { LocalPcSetup } from "@intentic/web/local-host";
import { computed } from "vue";
import { sandboxes } from "../machine";
import { setupDetail, setupDoing } from "./setupLine";

// THIS PC'S SETUP AS IT RUNS, in the first step of its card (PcSetupCard.vue; 2026-10-26). What it is on, in the reader's
// words, with how long is left and how far; under the bar, how that stands: while it moves the PC's sandboxes, which one,
// its step and its bytes as they go, and that every one is put back if anything fails, said here since This computer's
// engine card stands back meanwhile (DeviceView.vue). It used to be ic's English sentence over a bar that waited at the
// move's row for the whole move, so the setup read as stuck at 50% for minutes. What Windows asks for takes the line it
// holds up; a setup that has gone quiet is said, with a way on.

type Running = Extract<LocalPcSetup, { readonly state: `running` }>;

const props = defineProps<{
    readonly setup: Running;
    /** Minutes left by the check's estimate (pcCard.ts `minutesLeft`). */
    readonly left: number | undefined;
    readonly canShowLog: boolean;
}>();
const emit = defineEmits<{ again: []; log: [] }>();

const t = useT();

const percent = computed(() => Math.round(props.setup.percent));
const doing = computed(() => setupDoing(props.setup));
// A sandbox by the name the list shows it under, else its slug: the move stops each one, so the reader knows which.
const nameOf = (slug: string): string => sandboxes.value.find((sandbox) => sandbox.slug === slug)?.name ?? slug;
const detail = computed(() => setupDetail(props.setup, nameOf));
</script>

<template>
    <div class="flex flex-col gap-1.5">
        <div class="flex items-start gap-3 text-xs">
            <!-- Windows' own prompt, in place of the step it holds up: said once, as what to do. -->
            <span v-if="setup.needsYou" class="flex min-w-0 flex-1 items-start gap-1.5 font-medium text-warning">
                <Icon name="exclamation-circle" class="shrink-0" />
                <span>{{ t(`desktop.pcSetup.needsYou`) }}</span>
            </span>
            <span v-else class="min-w-0 flex-1 truncate text-content" v-tooltip.top="doing">{{ doing }}</span>
            <span class="shrink-0 text-2xs tabular-nums text-subtle">
                <template v-if="left !== undefined">{{ t(`desktop.pcSetup.minutesLeft`, { count: left }) }} · </template>{{ t(`desktop.pcSetup.percent`, { percent }) }}
            </span>
        </div>
        <div
            class="h-1.5 overflow-hidden rounded-full bg-line"
            role="progressbar"
            :aria-valuenow="percent"
            aria-valuemin="0"
            aria-valuemax="100"
            :aria-label="t(`desktop.pcSetup.pc.title`)"
        >
            <div class="h-full rounded-full bg-primary-500 transition-[width] duration-700 ease-smooth" :style="{ width: `${percent}%` }"></div>
        </div>
        <p v-if="detail && !setup.needsYou" class="text-2xs break-words tabular-nums text-muted">{{ detail }}</p>
    </div>
    <p v-if="setup.moving" class="max-w-read-sm text-2xs leading-relaxed text-subtle">{{ t(`desktop.engine.whileMoving`) }}</p>
    <!-- The step it went quiet on is the line above the bar, which is not said twice. -->
    <Notice v-if="setup.quietMinutes !== undefined" tone="warning" class="text-xs">
        <span class="block font-medium">{{ t(`desktop.pcSetup.quiet.title`, { count: setup.quietMinutes }) }}</span>
        <span class="mt-0.5 block">{{ t(`desktop.pcSetup.quiet.body`) }}</span>
        <span class="mt-2 flex flex-wrap items-center gap-x-4 gap-y-2">
            <Button size="small" tier="boring" :label="t(`desktop.pcSetup.quiet.again`)" @click="emit(`again`)" />
            <button v-if="canShowLog" type="button" :class="ui.textButton({ tone: `quiet` })" @click="emit(`log`)">
                {{ t(`desktop.pcSetup.showLog`) }}
            </button>
        </span>
    </Notice>
</template>
