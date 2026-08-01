<!-- Segmented control: a row of small toggle pills for switching between a few exclusive views
     (Preview/Source, Linux/Windows, Name/Content). Active pill sits on the overlay surface; idle
     pills are muted text. Native buttons keep it keyboard-accessible without ARIA wiring. -->
<script setup lang="ts" generic="T extends string">
import type { IconName } from "../icons/iconSets.js";

const { options, size = `sm` } = defineProps<{
    // badge: a small count chip after the label (e.g. unreviewed changes on a tab); hidden at 0/undefined.
    // mark: an icon in that same chip INSTEAD of a number, for a pending action whose size is not what the user
    // acts on (committed work still to push). Takes precedence — one chip states one thing.
    options: { label: string; value: T; title?: string; badge?: number; mark?: IconName; markTitle?: string }[];
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
            :class="[model === option.value ? `bg-overlay text-content` : `text-muted hover:text-content`, size === `xs` ? `px-1.5` : `px-2.5`]"
            @click="model = option.value"
        >
            {{ option.label
            }}<span v-if="option.mark !== undefined" class="ml-1 rounded-full bg-primary-600/15 px-1 text-2xs text-link" :title="option.markTitle"
                ><Icon :name="option.mark" /></span
            ><span v-else-if="option.badge !== undefined && option.badge > 0" class="ml-1 rounded-full bg-primary-600/15 px-1 text-2xs text-link">{{
                option.badge > 99 ? `99+` : option.badge
            }}</span>
        </button>
    </div>
</template>
