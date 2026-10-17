<script setup lang="ts">
import { Row, RowGroup } from "@intentic/ui";
import ToggleSwitch from "primevue/toggleswitch";
import { useSandboxSettings } from "../../../../models/sandbox/useSandboxSettings";
import { useT } from "@intentic/ui/i18n";

// Whether the daemon keeps every document's text shadow current in the background (derived/shadow-keeper.ts), and
// with it whether an agent's `rg` reads documents through fileq's preprocessor. On by default.

const t = useT();

const { settings, patch } = useSandboxSettings();
</script>

<template>
    <RowGroup data-setting="agent-document-search" :label="t(`sandbox.agentDocumentSearch.group`)">
        <Row icon="file-pdf" :title="t(`sandbox.agentDocumentSearch.title`)" :description="t(`sandbox.agentDocumentSearch.description`)">
            <template #control>
                <ToggleSwitch
                    :model-value="settings?.documentSearch ?? true"
                    :disabled="settings === undefined"
                    :aria-label="t(`sandbox.agentDocumentSearch.title`)"
                    @update:model-value="(value: boolean) => patch({ documentSearch: value })"
                />
            </template>
        </Row>
    </RowGroup>
</template>
