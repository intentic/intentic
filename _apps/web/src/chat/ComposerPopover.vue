<script setup lang="ts">
import { Icon, type IconName } from "@intentic/ui";

/* The panel that opens ABOVE the composer while a trigger character is live — `@` for a file, `/` for a
 * command. Chrome only: the raised surface, and the header that names what is being picked.
 *
 * The two pickers inside it were built by copying one into the other, which is visible in what they shared:
 * the same wrapper class string to the character, the same header, the same `MAX_ROWS = 8`, the same
 * `pickActive` — and the same `class="mp-row"` on every row, a class DEFINED IN NEITHER of them. It lived in
 * ChatModelPicker's `<style scoped>`, so Vue compiled it to `.mp-row[data-v-…]` and it matched nothing here:
 * both popovers had been shipping rows with no cursor and no hover tint since the day they were copied. That
 * is the failure mode this component exists to prevent — a copied class name looks identical in review and is
 * inert at runtime, and only one of the three copies had the stylesheet.
 *
 * Rows now wear the design system's `.ui-row-select`, which is a real global utility, so the hover the
 * highlight was always supposed to have is back and cannot be lost by moving a file.
 *
 * It stays absolutely positioned against the composer rather than becoming an <AnchoredOverlay>: it is not
 * anchored to a small trigger with room to flip around, it is a sheet pinned to the full width of the box the
 * user is typing in, and it must track that box's width as it grows. */

defineProps<{
    icon: IconName;
    title: string;
    /** A lookup is in flight — the spinner rides the header rather than replacing the rows already shown. */
    busy?: boolean;
}>();
</script>

<template>
    <div class="absolute bottom-full left-0 right-0 z-20 mb-1 overflow-hidden rounded-xl border border-line-strong bg-card shadow-lg">
        <p class="flex items-center gap-1.5 border-b border-line px-3 py-1.5 text-2xs uppercase tracking-wide text-subtle">
            <Icon :name="icon" class="text-2xs" />
            {{ title }}
            <Icon v-if="busy" name="spinner" class="text-2xs" spin />
        </p>
        <slot />
    </div>
</template>
