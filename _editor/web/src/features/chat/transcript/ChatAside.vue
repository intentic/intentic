<script setup lang="ts">
import type { IconName } from "@intentic/ui";
import { computed, ref } from "vue";

// One pill for every aside in a transcript: the turn's thinking, the context the sandbox prepended to a prompt, an
// errand's exact words. Rows are what a turn DID (tool cards); a pill is what it was given or thought — so the two
// never read as each other, and the aside costs one line's worth of quiet instead of a bar across the pane. The pill
// sits on the edge of the message whose material it is: the prompt's right, the answer's left.

const props = defineProps<{
    // The type signal, and the only difference between one pill and another.
    icon: IconName;
    label: string;
    // A reason the reader is owed rather than a preview of the material: carried on the pill, not on hover.
    detail?: string;
    // How many things the pill stands for; drawn from 2 up, since at one the label already says it.
    count?: number;
    // Names the hidden material on hover while the pill is shut; the pill itself stays one line whatever it holds.
    hint?: string;
    // Rides the prompt's own right edge rather than the answer's left: material the user's message carried.
    end?: boolean;
    // Fold state until someone presses it; a caller opens material that is still being written.
    openByDefault?: boolean;
    // Still being written: spins in the icon's place, so a shut pill still reads as live.
    busy?: boolean;
}>();

// Per-instance and unset by default, so `openByDefault` keeps tracking the turn until the reader overrides it.
const override = ref<boolean>();
const open = computed(() => override.value ?? props.openByDefault ?? false);
const toggle = (): void => {
    override.value = !open.value;
};
</script>

<template>
    <div class="flex w-full flex-col gap-1" :class="end && `items-end`">
        <button
            type="button"
            class="ui-chip max-w-full"
            :class="[end ? `self-end` : `self-start`, open && `bg-overlay text-content`]"
            :aria-expanded="open"
            v-tooltip.top="open ? undefined : hint"
            @click="toggle"
        >
            <Icon v-if="busy" name="spinner" spin class="shrink-0 text-2xs text-link" />
            <Icon v-else :name="icon" class="shrink-0 text-2xs text-link" />
            <span class="shrink-0 font-medium">{{ label }}</span>
            <span v-if="detail" class="min-w-0 truncate text-subtle">{{ detail }}</span>
            <span v-if="count !== undefined && count > 1" class="shrink-0 tabular-nums text-subtle">{{ count }}</span>
            <Icon :name="open ? `chevron-up` : `chevron-down`" class="shrink-0 text-2xs opacity-60" />
        </button>
        <!-- Full width whichever edge the pill took: the material is read left to right either way. -->
        <div v-if="open" class="w-full text-2xs leading-relaxed text-subtle">
            <slot />
        </div>
    </div>
</template>
