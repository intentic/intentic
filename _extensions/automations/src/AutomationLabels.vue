<!-- The two words an automation is found by besides its name: its one-line note, and the group that files it on a shelf. -->
<script setup lang="ts">
import { ui } from "@intentic/extension-ui";
import { computed, useId } from "vue";
import { useAutomations } from "./useAutomations";
import { t } from "./i18n.js";

const { nameLocked } = defineProps<{ nameLocked: boolean }>();
const note = defineModel<string>("note", { required: true });
const group = defineModel<string>("group", { required: true });

// Every group already named here, offered as the box is typed in: filing two jobs together means typing the same word,
// and a near miss ("Marketting") would quietly make a second shelf.
const { automations } = useAutomations();
const named = computed(() =>
    [...new Set(automations.value.flatMap((automation) => (automation.group === undefined ? [] : [automation.group.trim()])))].toSorted(),
);
const listId = useId();
</script>

<template>
    <div class="flex flex-col gap-3">
        <!-- One line on what it is for: a notification's title, and what a conversation it wakes reads it as. -->
        <label class="ui-field min-w-0 max-w-2xl">
            <span v-if="!nameLocked" class="ui-field-label">{{ t(`automationFields.noteOptional`) }}</span>
            <input
                v-model="note"
                maxlength="200"
                :placeholder="t(`automationFields.notePlaceholder`)"
                :aria-label="t(`automationFields.note`)"
                :class="ui.input()"
            />
            <span class="text-2xs text-subtle">{{ t(`automationFields.noteHint`) }}</span>
        </label>
        <label class="ui-field w-56 max-w-full shrink-0">
            <span class="ui-field-label">{{ t(`automationLabels.groupOptional`) }}</span>
            <input
                v-model="group"
                maxlength="40"
                :list="listId"
                :placeholder="t(`automationLabels.groupPlaceholder`)"
                :aria-label="t(`automationLabels.group`)"
                :class="ui.input()"
            />
            <datalist :id="listId">
                <option v-for="name in named" :key="name" :value="name" />
            </datalist>
            <span class="text-2xs text-subtle">{{ t(`automationLabels.groupHint`) }}</span>
        </label>
    </div>
</template>
