<script setup lang="ts">
import { Row, RowGroup } from "@intentic/ui";
import ToggleSwitch from "primevue/toggleswitch";
import { useSandboxSettings } from "../../overview/useSandboxSettings";
import { useT } from "@intentic/ui/i18n";

// Whether the agent may answer with a page drawn in the chat (`show_page`) and ask on one (`ask_page`). Off, a turn is
// offered neither tool and no word about them, so it spends nothing on them (agent/pages/page-tools.ts).

const t = useT();

const { settings, patch } = useSandboxSettings();
</script>

<template>
    <RowGroup :label="t(`sandbox.agentChatPages.group`)">
        <Row icon="globe" :title="t(`sandbox.agentChatPages.title`)" :description="t(`sandbox.agentChatPages.description`)">
            <template #control>
                <ToggleSwitch
                    :model-value="settings?.chatPages ?? true"
                    :disabled="settings === undefined"
                    :aria-label="t(`sandbox.agentChatPages.title`)"
                    @update:model-value="(value: boolean) => patch({ chatPages: value })"
                />
            </template>
        </Row>
    </RowGroup>
</template>
