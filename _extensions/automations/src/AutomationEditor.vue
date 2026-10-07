<script setup lang="ts">
import type { AutomationSummary, AutomationTemplate } from "@intentic/sandbox-contract";
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
        <Notice v-if="error" :of="noticeOf(error)" />
        <AutomationFields :state="form" :name-locked="true" />
        <!-- Match the composer's footer size because this is a form submit. -->
        <div class="flex items-center justify-end gap-2 border-t border-line-subtle pt-3">
            <Button :label="t(`automationRow.cancel`)" severity="secondary" :text="true" @click="emit(`done`)" />
            <Button :label="t(`automationRow.save`)" :loading="saving" @click="submit">
                <template #icon><Icon name="check" /></template>
            </Button>
        </div>
    </div>
</template>
