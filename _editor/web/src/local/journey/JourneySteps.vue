<!-- A FOLDER'S WAY TO AN AGENT, STEP BY STEP (journey.ts): its marker says how each step stands (ticked, under way, the
     reader's next press, waiting on them, failed, not yet), a rule runs down to the next, and its title says what it is.
     The dialog that asks lists them with a note each, before anything happens; the card in the window's corner lists
     them dense, its own title saying what the step under way is doing, and puts the setup's progress under that step.
     The same markers as This computer's setup card (desktop-app PcStep.vue), so a step reads the same wherever it is. -->
<script setup lang="ts">
import { Icon, tonePlate, toneWash } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import type { JourneyStep, JourneyStepState } from "./journey";

const { steps, dense = false } = defineProps<{
    steps: readonly JourneyStep[];
    /** The card's: smaller, and no notes, since the card's own title says what the step under way is doing. */
    dense?: boolean;
}>();

const t = useT();

const MARKER = {
    done: toneWash(`success`),
    current: tonePlate(`primary`),
    running: toneWash(`primary`),
    attention: tonePlate(`warning`),
    failed: tonePlate(`danger`),
    todo: `border border-line-strong text-muted`,
} as const satisfies Record<JourneyStepState, string>;

// A step behind the reader, or not reached yet, reads quieter than the one in play, so the eye goes there.
const titleTone = (state: JourneyStepState): string => (state === `done` || state === `todo` ? `text-muted` : `text-content`);
const noteTone = (state: JourneyStepState): string => {
    switch (state) {
        case `failed`:
            return `text-danger`;
        case `attention`:
            return `text-warning`;
        case `todo`:
            return `text-subtle`;
        default:
            return `text-muted`;
    }
};
</script>

<template>
    <ol class="flex flex-col" :aria-label="t(`local.journey.heading`)">
        <li
            v-for="(each, at) in steps"
            :key="each.key"
            class="flex"
            :class="dense ? `gap-2` : `gap-2.5`"
            :aria-current="each.state === `current` || each.state === `running` ? `step` : undefined"
        >
            <div class="flex flex-col items-center">
                <span
                    class="flex shrink-0 items-center justify-center rounded-full font-semibold tabular-nums"
                    :class="[MARKER[each.state], dense ? `h-4.5 w-4.5 text-3xs` : `h-5.5 w-5.5 text-2xs`]"
                >
                    <Icon v-if="each.state === `done`" name="check" :aria-label="t(`local.journey.done`)" />
                    <Icon v-else-if="each.state === `running`" name="spinner" spin aria-hidden="true" />
                    <template v-else>{{ at + 1 }}</template>
                </span>
                <span v-if="at < steps.length - 1" class="my-0.5 w-px flex-1 bg-line" aria-hidden="true"></span>
            </div>
            <div class="flex min-w-0 flex-1 flex-col" :class="at < steps.length - 1 ? (dense ? `pb-1.5` : `pb-3`) : ``">
                <p class="break-words font-medium" :class="[titleTone(each.state), dense ? `text-2xs leading-4.5` : `text-xs leading-5.5`]">{{ each.title }}</p>
                <p v-if="!dense && each.note" class="break-words text-2xs" :class="noteTone(each.state)">{{ each.note }}</p>
                <!-- What only the holder knows about a step: the setup's progress, under the sandbox's step on the card. -->
                <slot name="step" :step="each" />
            </div>
        </li>
    </ol>
</template>
