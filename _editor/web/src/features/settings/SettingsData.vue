<script setup lang="ts">
import { Button, Notice, Row, RowGroup } from "@intentic/ui";
import ToggleSwitch from "primevue/toggleswitch";
import { computed, ref } from "vue";
import { useRouter } from "vue-router";
import { analyticsAvailable, analyticsChoice, chooseAnalytics } from "../../app/analyticsConsent";
import { localHost } from "../../app/environments/localHost";
import { apiClient } from "../../lib/useApi";
import { useAccount } from "../../client/auth/useAccount";
import { useAuth } from "../../client/auth/useAuth";
import { useSandbox } from "../../client/sandbox/useSandbox";
import { useOperation } from "../../workbench/operations/operations";
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
// Every act on this page is the ledger's (operations.ts): the platform answers an export only once it has gathered every
// row, and a deletion only once access is off every sandbox, so a reader who looks elsewhere meanwhile comes back to the
// same press, or to how it ended. The hub row is marked by the ledger while either runs.
const handing = useOperation(`settings/data/workspace`);
const deleteInWorkspace = async (): Promise<void> => {
    removal.dismiss();
    await handing.run({
        what: t(`settings.settingsData.deleteInWorkspace`),
        failed: t(`settings.settingsData.workspaceNotOpened`),
        // The workspace window opening is the answer.
        quiet: true,
        task: () => localHost().openWorkspace(`/settings/data`),
    });
};

// GDPR data export: download everything the platform stores about the account as JSON (me.export).
const exporting = useOperation(`account/data/export`);
const exportError = computed(() => exporting.failure.value);
const exportData = async (): Promise<void> => {
    await exporting.run({
        // The platform gathers every row it holds about the account before it answers, so the row says so meanwhile.
        what: t(`settings.settingsData.gatheringData`),
        failed: t(`settings.settingsData.exportFailed`),
        done: () => t(`settings.settingsData.exportDownloaded`),
        task: async () => {
            const data = await apiClient.me.export();
            const url = URL.createObjectURL(new Blob([JSON.stringify(data, undefined, 2)], { type: `application/json` }));
            const link = document.createElement(`a`);
            link.href = url;
            link.download = `intentic-data-export.json`;
            link.click();
            URL.revokeObjectURL(url);
        },
    });
};

// GDPR account deletion: two-step inline confirm, then Better Auth deletes the user row
// (cascading sandboxes, sessions and grants) and we land back on the login page.
const confirmingDelete = ref(false);
const removal = useOperation(`account/data/delete`);
const deleting = removal.busy;
// The one line under the row: the deletion's own failure, or the workspace that would not open for it.
const deleteError = computed(() => {
    const failure = removal.failure.value ?? handing.failure.value;
    return failure === undefined ? undefined : (failure.detail ?? failure.title);
});
const confirmDelete = async (): Promise<void> => {
    await removal.run({
        what: t(`settings.settingsData.deletingAccount`),
        failed: t(`settings.settingsData.accountDeletionFailed`),
        // Ends on the login page, which is the answer.
        quiet: true,
        task: async () => {
            await deleteAccount(sandboxes.value);
            await router.push(`/login`);
        },
    });
};
</script>

<template>
    <div class="flex flex-col gap-6">
        <RowGroup v-if="analyticsAvailable()" :label="t(`settings.analytics.title`)">
            <Row icon="shield" :title="t(`settings.analytics.title`)" :description="t(`settings.analytics.description`)">
                <template #control>
                    <ToggleSwitch :model-value="analyticsChoice === `allow`" @update:model-value="chooseAnalytics($event ? `allow` : `deny`)" />
                </template>
            </Row>
        </RowGroup>
        <RowGroup :label="t(`settings.settingsData.dataPrivacy`)" :equal-rows="!confirmingDelete && !deleting && !deleteError && !exportError">
            <Row icon="download" :title="t(`settings.settingsData.exportMyData`)">
                <template #control>
                    <Button :label="t(`settings.settingsData.export`)" tier="boring" size="small" :loading="exporting.busy.value" @click="exportData" />
                </template>
                <template v-if="exportError" #below>
                    <Notice :of="exportError" />
                </template>
            </Row>
            <Row
                icon="trash"
                tone="danger"
                :title="t(`settings.settingsData.deleteAccount`)"
                :description="local ? t(`settings.settingsData.deleteFromWorkspace`) : t(`settings.settingsData.permanentlyRemovesAccountShared`)"
            >
                <template #control>
                    <Button v-if="local" :label="t(`settings.settingsData.deleteInWorkspace`)" tone="danger" size="small" :loading="handing.busy.value" @click="deleteInWorkspace">
                        <template #icon><Icon name="arrow-up-right" /></template>
                    </Button>
                    <Button v-else-if="!confirmingDelete && !deleting" :label="t(`ui.action.delete`)" tone="danger" size="small" @click="confirmingDelete = true" />
                </template>
                <!-- Kept open while a deletion runs, for a reader who came back to it. -->
                <template v-if="confirmingDelete || deleting || deleteError" #below>
                    <div v-if="confirmingDelete || deleting" class="flex items-center justify-end gap-2">
                        <span class="mr-auto text-2xs text-subtle">{{ t(`settings.settingsData.sureAccessRevokedBefore`) }}</span>
                        <Button
                            :label="t(`ui.action.cancel`)"
                            tier="quiet"
                            size="small"
                            :disabled="deleting"
                            @click="confirmingDelete = false"
                        />
                        <Button
                            :label="t(`settings.settingsData.deleteMyAccount`)"
                            tone="danger"
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
