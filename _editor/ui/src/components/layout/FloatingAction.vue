<!-- A phone screen's one creating press, floating over its bottom-right corner where the thumb already is. -->
<script setup lang="ts">
import type { IconName } from "../../icons/iconSets.js";
import Button from "../primitives/Button.vue";
import Icon from "../primitives/Icon.vue";

// Pinned to the nearest positioned ancestor, so the screen that owns it decides where it floats: over its own scroller,
// never over the tab bar below. That screen leaves room at the end of its list for it (a `pb-24`), or the last row sits
// under the press.
const { labelled = false } = defineProps<{
    /** The press's name: drawn beside the icon when `labelled`, otherwise its accessible name only. */
    label: string;
    icon: IconName;
    /** Spells the label out, for a press whose glyph alone does not say what it makes (a plus makes anything). */
    labelled?: boolean;
    disabled?: boolean;
}>();

defineEmits<{ click: [event: MouseEvent] }>();
</script>

<template>
    <!-- The position rides a wrapper, so PrimeVue's own button rules cannot override it. The wrapper is opaque, since the
         button's tier is a tint: floated over a list, the rows under it showed through the press. -->
    <div class="absolute bottom-4 right-4 z-10 rounded-full bg-card shadow-lg">
        <Button
            rounded
            class="h-14 py-0"
            :class="labelled ? `gap-2 px-5 text-sm font-semibold` : `w-14 px-0`"
            :disabled="disabled"
            :aria-label="labelled ? undefined : label"
            @click="$emit(`click`, $event)"
        >
            <Icon :name="icon" class="text-xl" />
            <span v-if="labelled">{{ label }}</span>
        </Button>
    </div>
</template>
