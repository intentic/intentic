<!-- A card's facts as label and value, the labels in one quiet column so the values line up and the eye runs down them,
     instead of each fact being a sentence that starts with its own label ("Approvers: …", "To …"). A value is shown
     whole, wrapping rather than cut: a truncated address is exactly how a lookalike gets through. -->
<script lang="ts">
export interface CardFact {
    readonly key: string;
    readonly label: string;
    readonly value: string;
    // An address, a command, an id: set in mono, a size down so it sits on the label's line.
    readonly mono?: boolean | undefined;
}
</script>

<script setup lang="ts">
defineProps<{ facts: readonly CardFact[] }>();
</script>

<template>
    <dl v-if="facts.length > 0" class="grid grid-cols-[max-content_minmax(0,1fr)] gap-x-3 gap-y-1 text-xs" data-card-facts>
        <template v-for="fact in facts" :key="fact.key">
            <dt class="text-subtle">{{ fact.label }}</dt>
            <dd class="min-w-0 break-words text-content/85" :class="{ 'font-mono text-2xs leading-5': fact.mono }">{{ fact.value }}</dd>
        </template>
    </dl>
</template>
