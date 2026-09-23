<script setup lang="ts">
import { Button, Modal, Row } from "@intentic/ui";
import ToggleSwitch from "primevue/toggleswitch";
import { ref, watch } from "vue";
import { useT } from "@intentic/ui/i18n";

// Whether to include secrets is a per-export argument, not a sandbox setting, so it lives in this modal next to the
// button that commits it rather than as a standing switch on the card. Starts locked every time; watches `open`, not
// `close`, so a mid-dismiss (Esc, mask) comes back the same as fresh.

const t = useT();

const { open, busy = false } = defineProps<{
    open: boolean;
    /** Held while the daemon names the bundle: the pack itself outlives this dialog and reports on the card. */
    busy?: boolean;
}>();

const emit = defineEmits<{ cancel: []; confirm: [secrets: boolean] }>();

const secrets = ref(false);
watch(
    () => open,
    (showing) => {
        if (showing) {
            secrets.value = false;
        }
    },
);
</script>

<template>
    <Modal :open="open" size="sm" :header="t(`sandbox.exportBundleDialog.exportEnvironment`)" @update:open="emit(`cancel`)">
        <div class="flex flex-col gap-4">
            <!-- The dialog describes the bundle contents and delayed result. -->
            <p class="text-xs text-subtle">
                {{ t(`sandbox.exportBundleDialog.packsSandboxsDefinitionTogether`) }}
                <span class="font-medium text-content">{{ t(`shared.exports`) }}</span>
                {{ t(`sandbox.exportBundleDialog.doneCloseTabWhile`) }}
            </p>

            <!-- Lock opens and turns warning-colored exactly when the bundle becomes unsafe to hand over. -->
            <div class="overflow-hidden rounded-lg border border-line">
                <Row
                    flush
                    as="label"
                    density="compact"
                    :icon="secrets ? `unlock` : `lock`"
                    :tone="secrets ? `warning` : `default`"
                    :title="t(`sandbox.exportBundleDialog.includeSecretValues`)"
                    class="cursor-pointer px-3.5 py-3"
                >
                    <template #description>
                        {{ t(`sandbox.exportBundleDialog.keysTokensStoredLogins`) }}
                    </template>
                    <template #control>
                        <ToggleSwitch v-model="secrets" />
                    </template>
                    <!-- `v-if` on the slot itself, not a `<p>` inside it: a passed slot is one the row renders, margin included. -->
                    <template v-if="secrets" #below>
                        <p class="text-2xs text-warning">{{ t(`sandbox.exportBundleDialog.storeFileLikePassword`) }}</p>
                    </template>
                </Row>
            </div>
        </div>

        <template #footer>
            <Button :label="t(`ui.action.cancel`)" severity="secondary" :text="true" @click="emit(`cancel`)" />
            <!-- Label mirrors the switch, so the confirm carries the choice too, not just the switch. -->
            <Button
                :label="secrets ? t(`sandbox.exportBundleDialog.exportSecrets`) : t(`shared.export`)"
                :severity="secrets ? `warn` : undefined"
                autofocus
                :loading="busy"
                @click="emit(`confirm`, secrets)"
            >
                <template #icon><Icon name="box" /></template>
            </Button>
        </template>
    </Modal>
</template>
