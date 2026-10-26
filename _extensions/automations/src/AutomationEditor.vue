<script setup lang="ts">
import type { AutomationSummary, AutomationTemplate } from "@intentic/sandbox-contract/schemas/automations";
import { Button, Icon, Notice, noticeOf } from "@intentic/extension-ui";
import { computed, ref } from "vue";
import type { AvailableSource } from "./catalog";
import AutomationFields from "./AutomationFields.vue";
import { useAutomations, useSandboxZone } from "./useAutomations";
import { useAutomationForm } from "./useAutomationForm";
import { t } from "./i18n.js";

// One automation's edit form, wherever it opens: in its row's drawer on the list, and in the card above the calendar.
// Loaded fresh on mount, discarded on Cancel, never half-typed against what the list shows as saved. No save-as-you-type:
// a half-typed Visitor chat would turn visitors away mid-keystroke.

const props = defineProps<{
    automation: AutomationSummary;
    listenerSources: readonly AvailableSource[];
    templates: readonly AutomationTemplate[];
    // Opened from the automation it edits, which it covers: the way back to it, and Save, sit at the top of the form,
    // where the reader is, rather than only past its last field. The calendar's card has its own close.
    back?: boolean;
}>();
const emit = defineEmits<{ done: [] }>();

const form = useAutomationForm(
    computed(() => props.listenerSources),
    computed(() => props.templates),
    useSandboxZone(),
);
form.load(props.automation);

const { save } = useAutomations();
const saving = computed(() => save.isPending.value);
const error = ref<string | undefined>(undefined);

const submit = async (): Promise<void> => {
    form.touchAll();
    if (!form.valid.value || saving.value) {
        return;
    }
    error.value = undefined;
    try {
        await save.mutateAsync(form.build());
        emit(`done`);
    } catch (err) {
        error.value = err instanceof Error ? err.message : t(`automationRow.couldntSave`);
    }
};
</script>

<template>
    <div class="flex flex-col gap-3">
        <div v-if="back" class="flex items-center gap-2 border-b border-line-subtle pb-3">
            <Button :label="t(`automationEditor.back`)" size="small" tier="quiet" @click="emit(`done`)">
                <template #icon><Icon name="arrow-left" /></template>
            </Button>
            <span class="min-w-0 flex-1 truncate text-xs text-subtle">{{ t(`automationEditor.allSettings`) }}</span>
            <Button :label="t(`automationRow.save`)" size="small" :loading="saving" @click="submit">
                <template #icon><Icon name="check" /></template>
            </Button>
        </div>
        <Notice v-if="error" :of="noticeOf(error)" />
        <AutomationFields :state="form" :name-locked="true" />
        <!-- Match the composer's footer size because this is a form submit. -->
        <div class="flex items-center justify-end gap-2 border-t border-line-subtle pt-3">
            <Button :label="t(`automationRow.cancel`)" tier="quiet" @click="emit(`done`)" />
            <Button :label="t(`automationRow.save`)" :loading="saving" @click="submit">
                <template #icon><Icon name="check" /></template>
            </Button>
        </div>
    </div>
</template>
