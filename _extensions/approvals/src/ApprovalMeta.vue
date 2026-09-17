<!-- Compact approval metadata with a readable destination and optional note. -->
<script setup lang="ts">
import { computed } from "vue";
import { destinationOf } from "./postText";
import { t } from "./i18n.js";

const { name, target, actsAs, note } = defineProps<{
    /** The platform's display name, or "Action": capitalized here, since an unknown platform arrives as its bare id. */
    name: string;
    target?: string;
    /* The metadata identifies the persona acting on the item. */
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
        <template v-if="actsAs"> <span class="text-subtle"> · </span>{{ t(`approvalMeta.as`) }} {{ actsAs }} </template>
        <template v-if="note"> <span class="text-subtle"> · </span>{{ note }} </template>
    </span>
</template>
