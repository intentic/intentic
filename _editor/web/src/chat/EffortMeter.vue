<!-- THE REASONING-EFFORT METER: the little ladder of segments, and the word for the rung it is on. The app's one
     effort control, over a plain (levels, level) pair rather than over a conversation, because it is now asked
     the same question in two different grammars: the composer sets the effort of the turn you are about to send
     (ComposerEffort binds this to a Conversation), and Sandbox ▸ Agent ▸ Models sets the effort of a model
     PINNED for runs nobody is watching, which has no conversation anywhere near it.

     THE RAMP IS THE POINT. A segment is not on-or-off: the lit ones climb from ~50% brand at Low to ~95% at the
     top, so the ladder reads as "how hard" at a glance rather than as a count of boxes. A copy that lit every
     segment the same colour would look right in a screenshot and wrong in use.

     IT DRAWS NOTHING when there are no levels to offer, which is the caller's answer rather than this
     component's: an ACP agent owns its own reasoning settings and OpenCode drops the field entirely (see
     `capabilities.effort`). Segments there are buttons that change nothing, which is worse than no segments.

     ON TOUCH THE LADDER IS A READOUT, NOT A CONTROL, and that is the one thing this component does differently
     per pointer. A rung is 9–14px wide. Making the strip 44px tall (chat.css) fixes the axis a thumb misses on
     and cannot fix the axis that matters here: five rungs a thumb can distinguish is 120px of a composer row
     that has a model pill, a persona, a microphone and a send button already. Widening them would also stop
     them being a ladder: a meter whose rungs are button-sized is a row of buttons, and the ramp that makes
     this readable at a glance is gone.

     So the phone gets the same ladder as a PICTURE, the level's word beside it, and one 44px target over the
     whole thing that opens the levels as a sheet. Nothing about the desktop control changes: five direct
     targets a mouse can hit exactly, which is why they exist. -->
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
    /**
     * What the word beside the ladder reads when NO rung is chosen — "Default" for a pinned model that takes
     * whatever the provider's own is. The composer never passes it: a conversation always has an effort.
     */
    emptyLabel?: string;
}>();

const effortIndex = computed(() => efforts.findIndex((option) => option.value === effort));
const effortLabel = computed(() => efforts.find((option) => option.value === effort)?.label ?? (effort === `` ? emptyLabel : effort));
/**
 * Every word the label can ever read on this scale, stacked invisibly under the live one so the label box is as
 * wide as its WIDEST rung and never resizes. The meter sits at the right edge of a row (the picker's effort line,
 * the composer), so a label that grows from "High" to "X-High" used to push the ladder sideways — out from under
 * the cursor that had just clicked it, mid-click-through. The box is fixed, so the rungs hold still.
 */
const labelWidths = computed(() => [...new Set([...efforts.map((option) => option.label), ...(emptyLabel === `` ? [] : [emptyLabel])])]);
const effortFill = (index: number): string => {
    const top = Math.max(1, efforts.length - 1);
    const pct = 50 + (index / top) * 45; // Low ≈ 50% brand → top level ≈ 95% brand
    return `color-mix(in oklab, var(--color-primary-500) ${pct}%, transparent)`;
};

// `coarse`, not `mobile`: this is a question about the POINTER reading the control, and a tablet on the desktop
// shell has the same thumb as a phone. It matches how the rest of the kit decides touch affordances.
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
        <!-- TOUCH: the ladder is inert ink inside one button, and the button says the whole state in words. -->
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
                <!-- The outer span keeps the caller's own display (labelClass hides the word in a narrow
                     composer); the grid that reserves the widest rung's width lives one level in. -->
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

        <!-- POINTER: five direct targets, exactly as before. -->
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
