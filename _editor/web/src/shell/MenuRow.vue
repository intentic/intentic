<!-- One row of the phone's Menu page: a <Row> that is a link when it names a place and a button when it does something. -->
<script setup lang="ts">
import { type IconName, Row, type RowTone } from "@intentic/ui";
import { RouterLink, type RouteLocationRaw } from "vue-router";

// The kit's own row, so the Menu reads like every other list on a phone (the Sandbox and Settings indexes, a
// section's groups) rather than a hand-drawn list of its own. A place is a link, hoverable and openable in a tab of
// its own; a press (switching sandbox, signing out) is a button, with no chevron, since it goes nowhere.
const { to, plain = false } = defineProps<{
    to?: RouteLocationRaw;
    icon?: IconName;
    title?: string;
    description?: string;
    tone?: RowTone;
    selected?: boolean;
    /** No chevron on a link that starts something (a new sandbox) rather than opening a place. */
    plain?: boolean;
}>();

const emit = defineEmits<{ press: [] }>();
</script>

<template>
    <component
        :is="to === undefined ? `button` : RouterLink"
        v-bind="to === undefined ? { type: `button` } : { to }"
        class="block w-full text-left"
        @click="to === undefined && emit(`press`)"
    >
        <Row as="div" interactive :icon="icon" :title="title" :description="description" :tone="tone" :selected="selected" :chevron="to !== undefined && !plain">
            <template v-if="$slots[`lead`]" #lead="scope"><slot name="lead" v-bind="scope" /></template>
            <template v-if="$slots[`title`]" #title><slot name="title" /></template>
            <template v-if="$slots[`description`]" #description><slot name="description" /></template>
            <template v-if="$slots[`meta`]" #meta><slot name="meta" /></template>
        </Row>
    </component>
</template>
