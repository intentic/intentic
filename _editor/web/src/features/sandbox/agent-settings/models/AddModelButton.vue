<script setup lang="ts">
import { ui } from "@intentic/ui";

// Shared trigger for the three pinned-model lists in Sandbox > Agent > Models, styled via the ui.inputSm recipe so all
// three stay identical. Emits its own element rather than a ref, since the page-owned picker overlay anchors to it; the
// trigger narrows on a phone so the row's own text yields space instead of squeezing the button unclickable.
const emit = defineEmits<{ open: [HTMLElement] }>();
const { label, disabled = false } = defineProps<{ label: string; disabled?: boolean }>();
</script>

<template>
    <button
        type="button"
        :class="
            ui.inputSm(
                `touch-target inline-flex w-56 cursor-pointer select-none items-center gap-2 transition-colors max-md:w-36 disabled:cursor-default`,
            )
        "
        :disabled="disabled"
        :aria-label="label"
        aria-haspopup="listbox"
        @click="emit(`open`, $event.currentTarget as HTMLElement)"
    >
        <span class="min-w-0 flex-1 truncate text-left text-subtle">Add a model…</span>
        <Icon name="chevron-down" class="shrink-0 text-2xs text-subtle" aria-hidden="true" />
    </button>
</template>
