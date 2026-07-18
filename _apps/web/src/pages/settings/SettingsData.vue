<script setup lang="ts">
import { Card } from "@intentic-app/ui";
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

// GDPR account deletion: two-step inline confirm, then Better Auth deletes the Stripe customer + user row
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
    <div class="flex flex-col gap-2.5">
        <Card class="flex items-center justify-between">
            <div class="flex min-w-0 items-center gap-2.5">
                <Icon name="download" class="text-lg text-muted" />
                <div class="min-w-0">
                    <h2 class="font-semibold leading-tight">Export my data</h2>
                    <p class="text-xs text-muted">Download everything the platform stores about your account as JSON.</p>
                </div>
            </div>
            <Button label="Export" severity="secondary" :outlined="true" size="small" :loading="exporting" @click="exportData" />
        </Card>

        <Card>
            <div class="flex items-center justify-between gap-3">
                <div class="flex min-w-0 items-center gap-2.5">
                    <Icon name="trash" class="text-lg text-danger" />
                    <div class="min-w-0">
                        <h2 class="font-semibold leading-tight">Delete account</h2>
                        <p class="text-xs text-muted">
                            Permanently removes your account, sandboxes, shared access and billing data. Cannot be undone.
                        </p>
                    </div>
                </div>
                <Button v-if="!confirmingDelete" label="Delete" severity="danger" :outlined="true" size="small" @click="confirmingDelete = true" />
            </div>
            <div v-if="confirmingDelete" class="mt-3 flex items-center justify-end gap-2 border-t border-line pt-3">
                <span class="mr-auto text-2xs text-subtle">Are you sure? This deletes everything immediately.</span>
                <Button label="Cancel" severity="secondary" text size="small" :disabled="deleting" @click="confirmingDelete = false" />
                <Button label="Delete my account" severity="danger" size="small" :loading="deleting" @click="confirmDelete" />
            </div>
            <p v-if="deleteError" class="mt-2 text-2xs text-danger">{{ deleteError }}</p>
        </Card>
    </div>
</template>
