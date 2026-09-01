<script setup lang="ts">
import { Icon } from "@intentic/ui";
import type { ComposerControl, ComposerMoreRow } from "./composerMore";

/* THE COMPOSER'S OVERFLOW: the controls this chat is leaving at their default, each named, valued and
 * explained. Which controls those are is composerMore.ts; this only draws them.
 *
 * EVERY ROW IS A HANDOFF, not a setting. Three of the four open the picker that already owns the choice (mode,
 * persona, run-through), anchored to the button this panel hangs off, so the choice is made in the same list it
 * has always been made in and this file never grows a second copy of one. The fourth is a toggle with nothing
 * to pick, so its row IS the press.
 *
 * A ROW PRESSED IS A ROW GONE, and that is the feedback: setting a control to anything but its default promotes
 * it out of here and into the composer row as a chip wearing its own name. Nothing lands silently in a menu the
 * user is about to close.
 *
 * The value sits on the right of the label because the labels are the scan target: four values in a column,
 * right-aligned against a column of labels, is the shape a settings list has, and it lets "what is this chat
 * currently doing" be read down one edge without reading a word of the left one. */

defineProps<{ rows: ComposerMoreRow[] }>();
const emit = defineEmits<{ pick: [control: ComposerControl] }>();
</script>

<template>
    <div class="flex flex-col p-1">
        <button
            v-for="row in rows"
            :key="row.key"
            type="button"
            class="ui-row-select flex items-start gap-2 rounded-lg px-2.5 py-1.5 text-left max-md:py-3"
            @click="emit(`pick`, row.key)"
        >
            <Icon :name="row.icon" class="mt-0.5 shrink-0 text-xs text-subtle" />
            <span class="flex min-w-0 flex-1 flex-col">
                <span class="flex min-w-0 items-baseline gap-2">
                    <span class="truncate text-sm text-content md:text-xs">{{ row.label }}</span>
                    <span class="ml-auto shrink-0 text-2xs text-subtle">{{ row.value }}</span>
                </span>
                <span class="text-2xs text-subtle">{{ row.description }}</span>
            </span>
        </button>
    </div>
</template>
