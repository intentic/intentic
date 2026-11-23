<script setup lang="ts">
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";

// WHERE A SIGN-IN IS, AS THREE STEPS: Open the provider's page, Sign in there, Connect here. Every handshake shape (a
// device code, a landing a machine of the owner's catches, a code or an address pasted back) is the same three steps
// with a different middle, so a reader learns one shape instead of four. The steps before `at` are done, `at` is the
// one under way, and `failed` says it stopped there. The bars between them fill as the steps behind them finish.

const t = useT();

const { at, failed = false } = defineProps<{ at: 0 | 1 | 2; failed?: boolean }>();

const steps = computed(() => [t(`connect.connectSteps.open`), t(`connect.connectSteps.signIn`), t(`connect.connectSteps.connect`)]);

type Standing = `done` | `now` | `failed` | `ahead`;
const standingOf = (index: number): Standing => (index < at ? `done` : index > at ? `ahead` : failed ? `failed` : `now`);

const DOT = {
    done: `border-success bg-success text-canvas`,
    now: `border-primary-500 text-primary-500 ring-4 ring-primary-500/15`,
    failed: `border-danger bg-danger text-canvas`,
    ahead: `border-line-strong text-subtle`,
} as const satisfies Record<Standing, string>;
</script>

<template>
    <ol class="flex max-w-md items-start" :aria-label="t(`connect.connectSteps.label`)">
        <template v-for="(name, index) in steps" :key="name">
            <li
                class="flex w-16 shrink-0 flex-col items-center gap-1.5"
                :aria-current="standingOf(index) === `now` || standingOf(index) === `failed` ? `step` : undefined"
            >
                <span
                    class="flex size-6 items-center justify-center rounded-full border-2 text-2xs font-semibold tabular-nums transition-[background-color,border-color,color,box-shadow] duration-300"
                    :class="DOT[standingOf(index)]"
                >
                    <!-- Keyed by its standing, so a step finishing pops its own tick rather than swapping a glyph in place. -->
                    <Icon
                        v-if="standingOf(index) === `done`"
                        :key="`done`"
                        name="check"
                        class="text-2xs motion-safe:animate-[ui-check-in_220ms_cubic-bezier(0.2,0.9,0.3,1.25)]"
                    />
                    <Icon v-else-if="standingOf(index) === `failed`" :key="`failed`" name="exclamation" class="text-2xs" />
                    <template v-else>{{ index + 1 }}</template>
                </span>
                <span class="text-2xs leading-tight transition-colors" :class="standingOf(index) === `ahead` ? `text-subtle` : `text-content`">{{ name }}</span>
                <span v-if="standingOf(index) === `done`" class="sr-only">{{ t(`connect.connectSteps.done`) }}</span>
            </li>
            <!-- The bar after a step fills once that step is done, from its left end. -->
            <li v-if="index < steps.length - 1" class="mt-3 h-0.5 min-w-4 flex-1 overflow-hidden rounded-full bg-line" aria-hidden="true">
                <span
                    class="block h-full origin-left rounded-full bg-success transition-transform duration-500 ease-smooth"
                    :class="index < at ? `scale-x-100` : `scale-x-0`"
                ></span>
            </li>
        </template>
    </ol>
</template>
