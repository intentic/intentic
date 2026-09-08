<!--
    Reasoning-effort ladder over a plain (levels, level) pair, used by the composer and by Sandbox ▸ Agent ▸ Models. Segments brighten with level
    rather than toggling on or off; it renders nothing when the caller has no levels to offer. On touch it is a readout that opens the levels as a
    sheet, not five direct targets.
-->
<script setup lang="ts">
import { computed, ref } from "vue";
import type { CatalogOption } from "@intentic/sandbox-contract";
import { ResponsiveOverlay, useDevice } from "@intentic/ui";

const emit = defineEmits<{ pick: [string] }>();
const {
    efforts,
    effort,
    disabled = false,
    labelClass = ``,
    emptyLabel = ``,
} = defineProps<{
    /** The rungs this model offers, weakest first (effortsFor). Empty draws nothing at all. */
    efforts: readonly CatalogOption[];
    /** The rung in effect. A value off this model's scale lights nothing, which is the caller's business to clamp. */
    effort: string;
    /** Greyed and inert: the chat composer's controls go quiet under a workflow badge. */
    disabled?: boolean;
    /** Extra classes on the level word, for a composer that drops it in a narrow container. */
    labelClass?: string;
    /** What shows when no rung is chosen (e.g. "Default" for a pinned model); the composer always has an effort. */
    emptyLabel?: string;
}>();

const effortIndex = computed(() => efforts.findIndex((option) => option.value === effort));
const effortLabel = computed(() => efforts.find((option) => option.value === effort)?.label ?? (effort === `` ? emptyLabel : effort));
/** Every possible label, stacked invisibly, so the box is fixed at its widest rung's width and never resizes. */
const labelWidths = computed(() => [...new Set([...efforts.map((option) => option.label), ...(emptyLabel === `` ? [] : [emptyLabel])])]);
const effortFill = (index: number): string => {
    const top = Math.max(1, efforts.length - 1);
    const pct = 50 + (index / top) * 45; // Low ≈ 50% brand → top level ≈ 95% brand
    return `color-mix(in oklab, var(--color-primary-500) ${pct}%, transparent)`;
};

// `coarse`, not `mobile`: about the pointer, not the device, so a desktop tablet gets the same touch
// treatment.
const { coarse } = useDevice();
const sheetOpen = ref(false);
const trigger = ref<HTMLButtonElement | null>(null);

const pick = (value: string): void => {
    sheetOpen.value = false;
    emit(`pick`, value);
};
</script>

<template>
    <div v-if="efforts.length > 0" class="flex shrink-0 items-center gap-1.5" role="group" aria-label="Reasoning effort">
        <!-- Touch: the ladder is inert ink inside one button; the button says the whole state in words. -->
        <template v-if="coarse">
            <button
                ref="trigger"
                type="button"
                class="flex min-h-11 shrink-0 items-center gap-1.5 rounded-md px-1 transition-colors active:bg-overlay"
                :disabled="disabled"
                :aria-label="`Reasoning effort: ${effortLabel}`"
                @click="sheetOpen = true"
            >
                <span class="flex items-center" aria-hidden="true">
                    <span
                        v-for="(option, index) in efforts"
                        :key="option.value"
                        class="composer-effort-seg composer-effort-seg-static"
                        :style="index <= effortIndex ? { backgroundColor: effortFill(index) } : undefined"
                    ></span>
                </span>
                <!--
                    Outer span carries labelClass (hides the word in a narrow composer); the width-reserving grid lives
                    one level in.
                -->
                <span class="text-2xs text-subtle" :class="labelClass">
                    <span class="grid">
                        <span v-for="word in labelWidths" :key="word" class="invisible col-start-1 row-start-1 whitespace-nowrap" aria-hidden="true">{{ word }}</span>
                        <span class="col-start-1 row-start-1 whitespace-nowrap">{{ effortLabel }}</span>
                    </span>
                </span>
            </button>
            <ResponsiveOverlay v-model="sheetOpen" :anchor="trigger ?? undefined" header="Reasoning effort" panel-class="w-56 p-1">
                <div class="flex flex-col gap-0.5">
                    <button
                        v-for="(option, index) in efforts"
                        :key="option.value"
                        type="button"
                        class="flex h-12 items-center gap-3 rounded-lg px-3 text-left text-sm transition-colors active:bg-overlay"
                        :class="effort === option.value ? `text-link` : `text-content`"
                        :aria-pressed="effort === option.value"
                        @click="pick(option.value)"
                    >
                        <!-- The row wears the rung it means, so the sheet and the meter are one control. -->
                        <span class="flex shrink-0 items-center" aria-hidden="true">
                            <span
                                v-for="(rung, at) in efforts"
                                :key="rung.value"
                                class="composer-effort-seg composer-effort-seg-static"
                                :style="at <= index ? { backgroundColor: effortFill(at) } : undefined"
                            ></span>
                        </span>
                        <span class="min-w-0 flex-1 truncate">{{ option.label }}</span>
                        <Icon v-if="effort === option.value" name="check" class="shrink-0 text-base" />
                    </button>
                </div>
            </ResponsiveOverlay>
        </template>

        <!-- Pointer: five direct targets. -->
        <template v-else>
            <div class="flex items-center">
                <button
                    v-for="(option, index) in efforts"
                    :key="option.value"
                    type="button"
                    class="composer-effort-seg"
                    :style="index <= effortIndex ? { backgroundColor: effortFill(index) } : undefined"
                    :disabled="disabled"
                    @click="emit(`pick`, option.value)"
                    :aria-label="option.label"
                    :aria-pressed="effort === option.value"
                ></button>
            </div>
            <span class="grid text-2xs text-subtle" :class="labelClass">
                <span v-for="word in labelWidths" :key="word" class="invisible col-start-1 row-start-1 whitespace-nowrap" aria-hidden="true">{{ word }}</span>
                <span class="col-start-1 row-start-1 whitespace-nowrap">{{ effortLabel }}</span>
            </span>
        </template>
    </div>
</template>
