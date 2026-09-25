<script setup lang="ts">
import { Row, RowGroup } from "@intentic/ui";
import ToggleSwitch from "primevue/toggleswitch";
import { useSandboxSettings } from "../../overview/useSandboxSettings";
import { useT } from "@intentic/ui/i18n";

// What happens to breakage found once the work has left its turn. Nothing checks inside a turn any more, and nothing
// asks the model to prove or look at anything when one ends: the main tree's own check runs after work lands, and a
// card says what that check and the turn itself showed (landCheck.ts). The one decision left here is who repairs a red.

const t = useT();

const { settings, patch } = useSandboxSettings();
</script>

<template>
    <RowGroup :label="t(`sandbox.agentChecks.afterLanding`)">
        <!-- A land that turns main red waits for the lands queued behind it, then goes back to its conversation or to a fresh
             one; main's CI red on one failure gets a fix agent once pushes go quiet. -->
        <Row icon="wrench" :title="t(`sandbox.agentChecks.repairAfterLanding`)" :description="t(`sandbox.agentChecks.repairAfterLandingNote`)">
            <template #control>
                <ToggleSwitch
                    :model-value="settings?.autoRepair ?? true"
                    :disabled="settings === undefined"
                    @update:model-value="(value: boolean) => patch({ autoRepair: value })"
                />
            </template>
        </Row>
    </RowGroup>
</template>
