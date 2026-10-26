<!-- An automation's settings as a column of label and value pairs, each value the place it is changed. -->
<script setup lang="ts">
import type { AutomationSummary } from "@intentic/sandbox-contract/schemas/automations";
import { computed } from "vue";
import { answersPhrase } from "../senderSummary";
import GateProperty from "./GateProperty.vue";
import GroupProperty from "./GroupProperty.vue";
import ModelProperty from "./ModelProperty.vue";
import ServiceProperty from "./ServiceProperty.vue";
import PersonaProperty from "./PersonaProperty.vue";
import PropertyRow from "./PropertyRow.vue";
import { FIXED_VALUE } from "./propertyLook";
import ScheduleProperty from "./ScheduleProperty.vue";
import { t } from "../i18n.js";

const props = defineProps<{
    automation: AutomationSummary;
    triggerLabel: string;
    // Where a fire goes when it is not a new agent ("Continues …", "Notifies you"); undefined for a new agent.
    targetPhrase: string | undefined;
    spent: boolean;
}>();

// Who it answers, in words: set in the editor, since its rules are a list of people, not one value.
const answers = computed(() => answersPhrase(props.automation.senders));
</script>

<template>
    <dl class="flex flex-col gap-2">
        <ScheduleProperty :automation="automation" :trigger-label="triggerLabel" :spent="spent" />
        <!-- A conversation runs as itself on its own model, and a notification runs nothing: only a new agent has either. -->
        <template v-if="targetPhrase === undefined">
            <ServiceProperty :automation="automation" />
            <PersonaProperty :automation="automation" />
            <ModelProperty :automation="automation" />
        </template>
        <PropertyRow v-else :label="t(`automationRow.then`)">
            <span :class="FIXED_VALUE"><span class="text-sm text-content">{{ targetPhrase }}</span></span>
        </PropertyRow>
        <GateProperty :automation="automation" />
        <PropertyRow v-if="answers" :label="t(`automationRow.answers`)">
            <span :class="FIXED_VALUE"><span class="text-sm text-content">{{ answers }}</span></span>
        </PropertyRow>
        <GroupProperty :automation="automation" />
    </dl>
</template>
