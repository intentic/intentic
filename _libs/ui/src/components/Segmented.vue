<!-- Segmented control: a row of small toggle pills for switching between a few exclusive views
     (Preview/Source, Linux/Windows, Name/Content). Active pill sits on the overlay surface; idle
     pills are muted text. Native buttons keep it keyboard-accessible without ARIA wiring. -->
<script setup lang="ts" generic="T extends string">
const { options, size = `sm` } = defineProps<{
    // badge: a small count chip after the label (e.g. unreviewed changes on a tab); hidden at 0/undefined.
    options: { label: string; value: T; title?: string; badge?: number }[];
    // sm: viewer toggles; xs: cramped rows (e.g. the workspace filter bar).
    size?: `sm` | `xs`;
}>();

const model = defineModel<T>({ required: true });
</script>

<template>
    <div role="tablist" class="flex items-center gap-0.5">
        <button
            v-for="option in options"
            :key="option.value"
            type="button"
            role="tab"
            :aria-selected="model === option.value"
            :title="option.title"
            class="cursor-pointer rounded-md py-0.5 text-2xs font-medium transition-colors"
            :class="[
                model === option.value ? `bg-overlay text-content` : `text-muted hover:text-content`,
                size === `xs` ? `px-1.5` : `px-2.5`,
            ]"
            @click="model = option.value"
        >
            {{ option.label
            }}<span v-if="option.badge !== undefined && option.badge > 0" class="ml-1 rounded-full bg-primary-600/15 px-1 text-2xs text-link">{{
                option.badge > 99 ? `99+` : option.badge
            }}</span>
        </button>
    </div>
</template>
