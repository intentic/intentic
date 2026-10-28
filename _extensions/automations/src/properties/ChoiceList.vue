<!-- One of a few ways a setting can go, each named and said in a line: the radio list a setting's panel offers when its choices need words, not a menu. -->
<script setup lang="ts" generic="T extends string">
import { Icon } from "@intentic/extension-ui";

defineProps<{
    choices: readonly { readonly value: T; readonly title: string; readonly note: string }[];
    /** What the choice is about, for a screen reader. */
    label: string;
}>();
const picked = defineModel<T>({ required: true });
</script>

<template>
    <div class="flex flex-col gap-1" role="radiogroup" :aria-label="label">
        <button
            v-for="choice in choices"
            :key="choice.value"
            type="button"
            role="radio"
            :aria-checked="picked === choice.value"
            class="flex items-start gap-3 rounded-md px-2 py-2 text-left transition-colors hover:bg-content/5"
            @click="picked = choice.value"
        >
            <Icon :name="picked === choice.value ? `check-circle` : `circle`" class="shrink-0 text-sm" :class="picked === choice.value ? `text-link` : `text-subtle`" />
            <span class="flex min-w-0 flex-col">
                <span class="text-sm text-content">{{ choice.title }}</span>
                <span class="text-xs text-subtle">{{ choice.note }}</span>
            </span>
        </button>
    </div>
</template>
