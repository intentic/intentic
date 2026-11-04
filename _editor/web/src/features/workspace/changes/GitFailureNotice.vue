<script setup lang="ts">
import { Notice } from "@intentic/ui";
import type { ActionFailure } from "../../../models/changes/useChanges";
import FixWithAgent from "../../../parts/fleet/FixWithAgent.vue";

// A failed git verb, where the panel draws it (under its repo's row, in the commit box, or named by repo when it has no
// row): the verb, git's own words, and the agent that settles it when only judgment can (ActionFailure.fix). Once an
// agent has it, the notice is the agent's and goes.

const { failure, title = undefined } = defineProps<{
    failure: ActionFailure;
    // The heading, where the verb alone does not say which repo ("Sync failed in targowisko").
    title?: string | undefined;
    dismissLabel: string;
}>();
const emit = defineEmits<{ dismiss: [] }>();
</script>

<template>
    <Notice tone="danger" size="sm" :dismiss-label="dismissLabel" @dismiss="emit(`dismiss`)">
        <span class="block font-medium">{{ title ?? failure.action }}</span>
        <span class="line-clamp-4 break-words text-muted" v-tooltip.top.overflow="failure.detail">{{ failure.detail }}</span>
        <template v-if="failure.fix" #actions>
            <FixWithAgent :fix="failure.fix" @started="emit(`dismiss`)" />
        </template>
    </Notice>
</template>
