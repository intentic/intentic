<!-- One answer in a secret's setting, as a radio with its consequence under it: what each choice does is said where it is chosen. -->
<script setup lang="ts">
defineProps<{ checked: boolean; title: string; note: string }>();
const emit = defineEmits<{ pick: [] }>();
</script>

<template>
    <button
        type="button"
        role="radio"
        :aria-checked="checked"
        class="flex items-start gap-3 rounded-md px-2 py-2 text-left transition-colors hover:bg-content/5 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-accent"
        @click="emit(`pick`)"
    >
        <Icon :name="checked ? `check-circle` : `circle`" class="shrink-0 text-sm" :class="checked ? `text-link` : `text-subtle`" />
        <span class="flex min-w-0 flex-col">
            <span class="text-sm text-content">{{ title }}</span>
            <span class="text-xs text-subtle">{{ note }}</span>
        </span>
    </button>
</template>
