<script setup lang="ts">
import { Row, RowGroup } from "@intentic/ui";
import Button from "primevue/button";
import { ref } from "vue";
import { useRouter } from "vue-router";
import { apiClient } from "../../composables/useApi";
import { errorMessage } from "../../composables/useAsyncAction";
import { useAuth } from "../../composables/useAuth";

/* Data & privacy: GDPR self-service — export everything the platform stores about the account, or delete it. */

const { deleteAccount } = useAuth();
const router = useRouter();

// GDPR data export: download everything the platform stores about the account as JSON (me.export).
const exporting = ref(false);
const exportData = async (): Promise<void> => {
    exporting.value = true;
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
        await deleteAccount();
        await router.push(`/login`);
    } catch (error) {
        deleteError.value = errorMessage(error, `Account deletion failed.`);
    } finally {
        deleting.value = false;
    }
};
</script>

<template>
    <div class="flex flex-col gap-6">
        <RowGroup label="Data &amp; privacy">
            <Row icon="download" title="Export my data" description="Download everything the platform stores about your account as JSON.">
                <template #control>
                    <Button label="Export" severity="secondary" :outlined="true" size="small" :loading="exporting" @click="exportData" />
                </template>
            </Row>
            <Row
                icon="trash"
                tone="danger"
                title="Delete account"
                description="Permanently removes your account, sandboxes and shared access. Cannot be undone."
            >
                <template #control>
                    <Button
                        v-if="!confirmingDelete"
                        label="Delete"
                        severity="danger"
                        :outlined="true"
                        size="small"
                        @click="confirmingDelete = true"
                    />
                </template>
                <template v-if="confirmingDelete || deleteError" #below>
                    <div v-if="confirmingDelete" class="flex items-center justify-end gap-2">
                        <span class="mr-auto text-2xs text-subtle">Are you sure? This deletes everything immediately.</span>
                        <Button label="Cancel" severity="secondary" text size="small" :disabled="deleting" @click="confirmingDelete = false" />
                        <Button label="Delete my account" severity="danger" size="small" :loading="deleting" @click="confirmDelete" />
                    </div>
                    <p v-if="deleteError" class="mt-2 text-2xs text-danger">{{ deleteError }}</p>
                </template>
            </Row>
        </RowGroup>
    </div>
</template>
