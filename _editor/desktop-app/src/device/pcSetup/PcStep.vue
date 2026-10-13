<script setup lang="ts">
import { tonePlate, toneWash } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import type { StepState } from "./pcCard";

// ONE STEP OF THE CARD FOR THIS PC'S SETUP (pcCard.ts `pcSteps`): its number or what became of it in the marker, a rule
// down to the next step, its title with whatever stands beside it (a word, a press), and below them what the step is
// about, then its controls while it is open. The marker carries the state, so the title needs no word for it.

const props = defineProps<{
    readonly n: number;
    readonly state: StepState;
    readonly title: string;
    /** The last step draws no rule under its marker. */
    readonly last?: boolean;
}>();

const t = useT();

const MARKER = {
    done: toneWash(`success`),
    current: tonePlate(`primary`),
    running: toneWash(`primary`),
    attention: tonePlate(`warning`),
    failed: tonePlate(`danger`),
    todo: `border border-line-strong text-muted`,
    locked: `border border-dashed border-line-strong text-subtle`,
} as const satisfies Record<StepState, string>;

// A step not open yet reads quieter than the ones in play, so the eye goes to what can be done.
const quiet = computed(() => props.state === `todo` || props.state === `locked`);
</script>

<template>
    <li class="flex gap-3" :aria-current="state === `current` ? `step` : undefined">
        <div class="flex flex-col items-center">
            <span class="flex h-6 w-6 shrink-0 items-center justify-center rounded-full text-2xs font-semibold tabular-nums" :class="MARKER[state]">
                <Icon v-if="state === `done`" name="check" :aria-label="t(`desktop.pcSetup.step.done`)" />
                <Icon v-else-if="state === `running`" name="spinner" spin />
                <Icon v-else-if="state === `locked`" name="lock" class="text-3xs" />
                <template v-else>{{ n }}</template>
            </span>
            <span v-if="!last" class="mt-1.5 w-px flex-1 bg-line" aria-hidden="true"></span>
        </div>
        <div class="flex min-w-0 flex-1 flex-col gap-2.5" :class="last ? `` : `pb-6`">
            <div class="flex min-h-6 flex-wrap items-center gap-x-3 gap-y-1.5">
                <div class="min-w-0 flex-1">
                    <h3 class="text-sm leading-6 font-medium" :class="quiet ? `text-muted` : `text-content`">{{ title }}</h3>
                    <p v-if="$slots[`line`]" class="text-xs leading-relaxed" :class="quiet ? `text-subtle` : `text-muted`"><slot name="line" /></p>
                </div>
                <div v-if="$slots[`aside`]" class="flex shrink-0 items-center gap-2"><slot name="aside" /></div>
            </div>
            <slot />
        </div>
    </li>
</template>
