<script setup lang="ts">
import { AgentRunButton, cmp, Icon, Notice, noticeOf, timeAgo, type AgentRunChoice, useAgentRunPick } from "@intentic/extension-ui";
import type { DeployResource } from "./contract";
import { host } from "./host";
import type { Incident } from "./incidents";
import { INCIDENT_TONE } from "./stateVisual";

/* ONE LINE OF THE "NEEDS YOU" PANEL — what moved, when, and the button that puts an agent on it.
 *
 * IT IS A COMPONENT FOR ONE REASON: the caret. The strip is a `v-for`, and the model chosen for one incident
 * must not be the model spent on the next one down — so the pick has to be per row, which means per component.
 * That is the same reason ResourceRow holds its own, and it is why this line stopped being inline template.
 *
 * The button is the strip's whole point. This panel exists so an operator does not have to find the row for the
 * thing that just broke, and a shortcut that could not do what the row does — including choosing what it
 * spends — would send them back down to the board anyway. */

const { incident, resource } = defineProps<{
    incident: Incident;
    // The resource the alert names, when it is on this board. Absent ⇒ the alert is about something we cannot
    // act on, and the line states the problem without offering a button that would fail.
    resource: DeployResource | undefined;
    failure: string | undefined;
}>();
const emit = defineEmits<{ fix: [resource: DeployResource, pick: AgentRunChoice | undefined] }>();

const fixModel = useAgentRunPick(() => host().models);
const startFix = (): void => {
    if (resource !== undefined) {
        emit(`fix`, resource, fixModel.overridden.value ? fixModel.model.value : undefined);
        fixModel.clear();
    }
};
</script>

<template>
    <div class="flex flex-col gap-1">
        <!-- items-start, not items-center: a summary long enough to wrap ("api running → restarting on prod-1"
             on a phone) otherwise pushes its own dot onto a line of its own, and a bullet with nothing beside
             it reads as a rendering fault. -->
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
                :model-label="fixModel.model.value.label"
                :overridden="fixModel.overridden.value"
                @run="startFix"
                @pick="fixModel.choose"
            />
        </div>
        <Notice v-if="failure" :of="noticeOf(failure)" />
    </div>
</template>
