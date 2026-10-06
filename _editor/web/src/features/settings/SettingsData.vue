<script setup lang="ts">
import { Button, Row, RowGroup } from "@intentic/ui";
import { messageOr } from "@intentic/ui/async";
import { ref } from "vue";
import { useRouter } from "vue-router";
import { localHost } from "../../app/environments/localHost";
import { apiClient } from "../../lib/useApi";
import { useAccount } from "../../client/auth/useAccount";
import { useAuth } from "../../client/auth/useAuth";
import { useSandbox } from "../../client/sandbox/useSandbox";
import { useHubWork } from "../../workbench/hub/hubWork";
import { useT } from "@intentic/ui/i18n";

const t = useT();

/* Data & privacy: GDPR self-service: export everything the platform stores about the account, or delete it. */

const { deleteAccount } = useAuth();
const { sandboxes } = useSandbox();
const router = useRouter();

// A desktop window on a folder knows only its folder, and deleting the account takes this account's access off every
// sandbox first (useAuth.ts `deleteAccount`). So there it is done from the workspace, which knows them all; the export
// is the platform's alone and works in place.
const { local } = useAccount();
const handing = ref(false);
const deleteInWorkspace = async (): Promise<void> => {
    handing.value = true;
    deleteError.value = undefined;
    try {
        await localHost().openWorkspace(`/settings/data`);
    } catch (error) {
        deleteError.value = messageOr(error, `The workspace could not be opened.`);
    } finally {
        handing.value = false;
    }
};

// GDPR data export: download everything the platform stores about the account as JSON (me.export).
const hubWork = useHubWork();
const exporting = ref(false);
const exportData = async (): Promise<void> => {
    exporting.value = true;
    // The platform gathers every row it holds about the account before it answers, so the row says so meanwhile.
    const endMark = hubWork.begin(`Gathering your data`);
    try {
        const data = await apiClient.me.export();
        const url = URL.createObjectURL(new Blob([JSON.stringify(data, undefined, 2)], { type: `application/json` }));
        const link = document.createElement(`a`);
        link.href = url;
        link.download = `intentic-data-export.json`;
        link.click();
        URL.revokeObjectURL(url);
    } finally {
        exporting.value = false;
        endMark();
    }
};

// GDPR account deletion: two-step inline confirm, then Better Auth deletes the user row
// (cascading sandboxes, sessions and grants) and we land back on the login page.
const confirmingDelete = ref(false);
const deleting = ref(false);
const deleteError = ref<string | undefined>(undefined);
const confirmDelete = async (): Promise<void> => {
    deleting.value = true;
    deleteError.value = undefined;
    try {
        await deleteAccount(sandboxes.value);
        await router.push(`/login`);
    } catch (error) {
        deleteError.value = messageOr(error, `Account deletion failed.`);
    } finally {
        deleting.value = false;
    }
};
</script>

<template>
    <div class="flex flex-col gap-6">
        <RowGroup :label="t(`settings.settingsData.dataPrivacy`)" :equal-rows="!confirmingDelete && !deleteError">
            <Row icon="download" :title="t(`settings.settingsData.exportMyData`)">
                <template #control>
                    <Button :label="t(`settings.settingsData.export`)" severity="secondary" size="small" :loading="exporting" @click="exportData" />
                </template>
            </Row>
            <Row
                icon="trash"
                tone="danger"
                :title="t(`settings.settingsData.deleteAccount`)"
                :description="local ? t(`settings.settingsData.deleteFromWorkspace`) : t(`settings.settingsData.permanentlyRemovesAccountShared`)"
            >
                <template #control>
                    <Button v-if="local" :label="t(`settings.settingsData.deleteInWorkspace`)" severity="danger" size="small" :loading="handing" @click="deleteInWorkspace">
                        <template #icon><Icon name="arrow-up-right" /></template>
                    </Button>
                    <Button v-else-if="!confirmingDelete" :label="t(`ui.action.delete`)" severity="danger" size="small" @click="confirmingDelete = true" />
                </template>
                <template v-if="confirmingDelete || deleteError" #below>
                    <div v-if="confirmingDelete" class="flex items-center justify-end gap-2">
                        <span class="mr-auto text-2xs text-subtle">{{ t(`settings.settingsData.sureAccessRevokedBefore`) }}</span>
                        <Button
                            :label="t(`ui.action.cancel`)"
                            severity="secondary"
                            text
                            size="small"
                            :disabled="deleting"
                            @click="confirmingDelete = false"
                        />
                        <Button
                            :label="t(`settings.settingsData.deleteMyAccount`)"
                            severity="danger"
                            size="small"
                            :loading="deleting"
                            @click="confirmDelete"
                        />
                    </div>
                    <p v-if="deleteError" class="mt-2 text-2xs text-danger">{{ deleteError }}</p>
                </template>
            </Row>
        </RowGroup>
    </div>
</template>
