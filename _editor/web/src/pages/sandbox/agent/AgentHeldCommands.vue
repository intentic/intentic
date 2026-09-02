<script setup lang="ts">
import { Row, RowGroup } from "@intentic/ui";
import ToggleSwitch from "primevue/toggleswitch";
import { useSandboxSettings } from "../../../composables/sandbox/useSandboxSettings";

// What a permission card shows before you answer for it, under the rules that raise the cards. Off by default:
// it spends a quick-model call per card on the owner's own account. The sentence is written from the command
// text by the quick model, never by the agent asking, and the command itself is never replaced by it.
const { settings, patch } = useSandboxSettings();
</script>

<template>
    <RowGroup label="Held commands">
        <Row
            icon="comments"
            title="Explain held commands"
            description="One plain sentence above each held command. Costs a quick-model call per card."
        >
            <template #control>
                <ToggleSwitch
                    :model-value="settings?.explainCommands ?? false"
                    :disabled="settings === undefined"
                    @update:model-value="(value: boolean) => patch({ explainCommands: value })"
                />
            </template>
        </Row>
    </RowGroup>
</template>
