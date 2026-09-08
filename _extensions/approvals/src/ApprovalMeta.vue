<!--
    Muted meta line under an approval: what it is, where, whose name, and a trailing note. A reply target renders through destinationOf (postText.ts)
    as place plus relationship ('reply in r/ClaudeAI'), not the raw URL; already-short targets pass through unchanged. Truncates as one line, not per
    segment, so the note is never crowded out.
-->
<script setup lang="ts">
import { computed } from "vue";
import { destinationOf } from "./postText";

const { name, target, actsAs, note } = defineProps<{
    /** The platform's display name, or "Action": capitalized here, since an unknown platform arrives as its bare id. */
    name: string;
    target?: string;
    /* WHOSE NAME IT ACTS UNDER (the item's `actsAs` persona), because the row it sits on carries an Approve
     * button and this is the one fact that button cannot be taken back on. Between the place and the time on
     * purpose: the reader wants where before who, and who before when. */
    actsAs?: string;
    /** One trailing fact the section cares about ("proposed 3h ago"). */
    note?: string;
}>();

const destination = computed(() => (target === undefined ? undefined : destinationOf(target)));
const full = computed<string | undefined>(() =>
    target === undefined ? undefined : [name, target, actsAs === undefined ? undefined : `as ${actsAs}`, note].filter(Boolean).join(` · `),
);
</script>

<template>
    <span class="block truncate" v-tooltip.top="full">
        <span class="capitalize">{{ name }}</span>
        <template v-if="destination">
            <span class="text-subtle"> · </span>
            <template v-if="destination.verb">{{ destination.verb }}&nbsp;</template>
            <a v-if="destination.href" :href="destination.href" target="_blank" rel="noopener" class="text-link hover:underline">
                {{ destination.label }}<Icon name="external-link" class="ml-1 text-2xs" />
            </a>
            <template v-else>{{ destination.label }}</template>
        </template>
        <template v-if="actsAs"> <span class="text-subtle"> · </span>as {{ actsAs }} </template>
        <template v-if="note"> <span class="text-subtle"> · </span>{{ note }} </template>
    </span>
</template>
