<script setup lang="ts">
import { extensionIdOf } from "@intentic/extension-manifest";
import type { ExtensionSummary } from "@intentic/sandbox-contract/schemas/extension-updates";
import ToggleSwitch from "primevue/toggleswitch";
import { useT } from "@intentic/ui/i18n";

// An extension's on/off switch, the same on its Installed row and at the head of its page. An essential extension's
// switch stays drawn, on and disabled, because a control that vanishes reads as a bug.

const t = useT();

defineProps<{ extension: ExtensionSummary; pending: boolean }>();
const emit = defineEmits<{ toggle: [enabled: boolean] }>();
</script>

<template>
    <span
        v-if="extension.essential"
        v-tooltip.top="{ title: t(`sandbox.extensionRow.alwaysOnTitle`), note: t(`sandbox.extensionRow.showsBackgroundWork`) }"
        class="cursor-not-allowed"
    >
        <ToggleSwitch
            class="ui-switch-sm pointer-events-none"
            :model-value="true"
            disabled
            :aria-label="t(`sandbox.extensionRow.alwaysOn`, { manifest: extensionIdOf(extension.manifest) })"
        />
    </span>
    <ToggleSwitch
        v-else
        class="ui-switch-sm"
        :model-value="extension.enabled"
        :disabled="pending"
        :aria-label="t(`sandbox.extensionRow.enable`, { manifest: extensionIdOf(extension.manifest) })"
        @update:model-value="(value: boolean) => emit(`toggle`, value)"
    />
</template>
