<!-- THE WAY TO UNINSTALL INTENTIC, in the Devices view's Danger zone: the row the workspace's Devices view gives Revoke
     access there, and one button that opens the review (UninstallDialog.vue). Nothing is removed from here; the dialog
     says what would be, and asks. -->
<script setup lang="ts">
import { Button, Icon, Row } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { ref } from "vue";
import UninstallDialog from "./UninstallDialog.vue";

const { appVersion } = defineProps<{
    /** The app's own version, for the dialog's ledger when ic does not say. */
    appVersion?: string | undefined;
}>();

const t = useT();
const open = ref(false);
</script>

<template>
    <Row icon="trash" tone="danger" :title="t(`desktop.uninstall.sectionTitle`)" :description="t(`desktop.uninstall.sectionLead`)">
        <template #control>
            <Button size="small" tone="danger" :label="t(`desktop.uninstall.open`)" @click="open = true">
                <template #icon><Icon name="trash" /></template>
            </Button>
        </template>
    </Row>
    <UninstallDialog v-model:open="open" :app-version="appVersion" />
</template>
