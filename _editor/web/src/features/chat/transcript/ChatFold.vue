<script setup lang="ts">
import type { IconName } from "@intentic/ui";
import { computed, ref } from "vue";

// One fold for every block of secondary material in a transcript: the turn's thinking, the context the daemon prepended
// to a prompt, an errand's exact words. One grammar for all of them — quiet header line, body on a rail — so the icon is
// the only thing that says which kind of material is hidden.

const props = defineProps<{
    // The type signal, and the only difference between one fold and another.
    icon: IconName;
    label: string;
    // Names the hidden material while the fold is shut; dropped once open, where the body itself says it.
    detail?: string;
    // Fold state until someone presses it; a caller opens material that is still being written.
    openByDefault?: boolean;
    // Still being written: spins on the header, so a shut fold still reads as live.
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
    <!-- Open, header and body share one quiet plate; shut, the header is a line of its own with nothing under it. -->
    <div class="flex w-full flex-col overflow-hidden rounded-lg transition-colors" :class="open ? `bg-overlay/35` : ``">
        <button
            type="button"
            class="group/fold flex w-full items-center gap-2 px-2 py-1 text-left text-2xs leading-none text-subtle transition-colors"
            :class="!open && `hover:bg-overlay`"
            :aria-expanded="open"
            @click="toggle"
        >
            <Icon :name="icon" class="shrink-0 text-2xs text-link" />
            <span class="shrink-0 font-medium text-muted transition-colors group-hover/fold:text-content">{{ label }}</span>
            <!-- The detail names what's hidden, so it goes once the body says it; the spacer keeps the chevron on its own edge. -->
            <span v-if="detail !== undefined && !open" class="min-w-0 flex-1 truncate transition-colors group-hover/fold:text-muted">{{
                detail
            }}</span>
            <span v-else class="flex-1"></span>
            <Icon v-if="busy" name="spinner" spin class="shrink-0 text-2xs" />
            <Icon :name="open ? `chevron-up` : `chevron-down`" class="shrink-0 text-2xs opacity-60 transition-opacity group-hover/fold:opacity-100" />
        </button>
        <!-- Capped and scrolled, not clamped, so long material stays reachable without pushing the answer off screen.
             `px-2` is the header's own inset: header and body read as one object only if their text starts on one edge. -->
        <div v-if="open" class="scrollbar-thin max-h-64 overflow-auto border-t border-line/40 px-2 py-2 text-2xs leading-relaxed text-subtle">
            <slot />
        </div>
    </div>
</template>
