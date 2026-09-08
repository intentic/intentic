<script setup lang="ts">
import { AgentRunButton, ui, Icon, Notice, noticeOf, timeAgo, type AgentRunChoice, useAgentRunPick } from "@intentic/extension-ui";
import type { DeployResource } from "./contract";
import { host } from "./host";
import type { Incident } from "./incidents";
import { INCIDENT_TONE } from "./stateVisual";

// One line of the incident panel: what moved, when, and the button to put an agent on it. A component because each
// row's model pick must be independent in this v-for. The button matters because it can choose what it spends; a
// shortcut that couldn't wouldn't save the trip to the board.

const { incident, resource } = defineProps<{
    incident: Incident;
    // Alert's named resource, when it's on this board; absent means the line states the problem with no button.
    resource: DeployResource | undefined;
    failure: string | undefined;
}>();
const emit = defineEmits<{ fix: [resource: DeployResource, pick: AgentRunChoice | undefined] }>();

const fixModel = useAgentRunPick(() => host().models, `deployment-fix`);
const startFix = (): void => {
    if (resource !== undefined) {
        emit(`fix`, resource, fixModel.overridden.value ? fixModel.model.value : undefined);
        fixModel.clear();
    }
};
</script>

<template>
    <div class="flex flex-col gap-1">
        <!-- items-start, not items-center: a wrapped summary would otherwise push the dot onto its own line. -->
        <div class="flex items-start gap-2">
            <span class="mt-1.5 h-2 w-2 shrink-0 rounded-full" :class="INCIDENT_TONE[incident.tone].dot"></span>
            <span class="min-w-0 flex-1 text-sm text-content">
                {{ incident.summary }}
                <span class="whitespace-nowrap text-2xs text-subtle">{{ timeAgo(incident.alert.ts) }}</span>
            </span>
            <AgentRunButton
                v-if="resource"
                label="Ask the agent"
                icon="sparkles"
                class="-my-1 shrink-0"
                severity="secondary"
                text
                :picker="fixModel"
                @run="startFix"
            />
        </div>
        <Notice v-if="failure" :of="noticeOf(failure)" />
    </div>
</template>
