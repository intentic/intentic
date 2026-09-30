<script setup lang="ts">
import { FACE_SIZES, PersonaFace } from "@intentic/ui";

// Shared appearance only: chat owns its scope, badges and shortcuts; settings owns its editor selection.
defineProps<{
    persona?: { id: string; label?: string };
    label: string;
    selected: boolean;
    nameId?: string;
}>();
</script>

<template>
    <button
        type="button"
        class="ui-row-select ui-row-select-horizontal group relative flex min-w-0 flex-col items-center justify-center gap-1 rounded-lg px-1 py-1.5"
        :class="{ 'ui-row-select-on': selected }"
    >
        <span class="relative flex shrink-0">
            <slot name="face"><PersonaFace v-if="persona" :persona="persona" :size="FACE_SIZES.card" /></slot>
            <slot name="badges" />
        </span>
        <span
            :id="nameId"
            class="line-clamp-2 min-h-[2.5em] w-full min-w-0 break-words text-center text-xs font-medium leading-tight"
            :class="selected ? 'text-content' : 'text-muted'"
            >{{ label }}</span
        >
        <slot />
    </button>
</template>
