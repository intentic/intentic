<!-- The rebuild of a sandbox Docker Compose runs: the edit its compose file needs (composeRebuild.ts), then Compose's
     own redeploy. No button and no `ic` command: nothing on this page reaches the file, and a swap would start a container
     Compose does not know. -->
<script setup lang="ts">
import { COMPOSE_UPDATE_COMMAND } from "@intentic/sandbox-run";
import { Code, CopyButton } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { composeRebuildOf } from "./composeRebuild";

const props = defineProps<{
    // The approved recipe waiting to be built, as the daemon composed it.
    hash: string;
    content: string;
}>();

const t = useT();

const edit = computed(() => composeRebuildOf(props.hash, props.content));
</script>

<template>
    <div class="flex flex-col gap-2" data-executor="compose">
        <template v-if="edit.snippet !== ``">
            <p class="text-xs text-content">{{ t(`sandbox.environmentCard.composeLead`) }}</p>
            <Code :code="edit.snippet" lang="yaml" :label="t(`sandbox.environmentCard.composeServiceLabel`)" :wrap="false" :clamp-lines="edit.builds ? 12 : undefined" />
            <p class="text-2xs text-subtle">{{ t(`sandbox.environmentCard.composeHashLead`) }}</p>
        </template>
        <p v-else class="text-xs text-content">{{ t(`sandbox.environmentCard.composeHashOnlyLead`) }}</p>
        <p class="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-2xs">
            <code class="font-mono text-content break-all">{{ edit.hashEnv }}</code>
            <CopyButton :text="edit.hashEnv" />
        </p>
        <p class="flex flex-wrap items-center gap-x-1.5 gap-y-1 text-2xs text-subtle">
            <span>{{ t(`sandbox.environmentCard.composeRedeploy`) }}</span>
            <code class="font-mono text-content">{{ COMPOSE_UPDATE_COMMAND }}</code>
        </p>
    </div>
</template>
