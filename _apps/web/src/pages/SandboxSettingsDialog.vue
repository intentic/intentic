<script setup lang="ts">
import { cmp } from "@intentic-app/ui";
import Button from "primevue/button";
import Dialog from "primevue/dialog";
import { computed, ref, watch } from "vue";
import { fileToSquareDataUrl } from "../composables/imageDataUrl";
import { useSandbox } from "../composables/useSandbox";

/* Owner-only settings for the ACTIVE sandbox: rename it and/or pick a logo for the switcher. The picked file
 * never uploads as a file — it is downscaled to a small square data URL in the browser and stored as a string
 * (sandbox.update). Only changed fields are sent. */

const visible = defineModel<boolean>(`visible`, { default: false });

const sandbox = useSandbox();

const name = ref(``);
// The downscaled data URL of a freshly picked logo, previewed until Save sends it. Undefined = keep the current one.
const stagedImage = ref<string | undefined>(undefined);
const fileInput = ref<HTMLInputElement | null>(null);
const busy = ref(false);
const error = ref<string | undefined>(undefined);

watch(visible, (open) => {
    if (!open) {
        return;
    }
    name.value = sandbox.active.value?.name ?? ``;
    stagedImage.value = undefined;
    error.value = undefined;
    nameTouched.value = false;
});

const nameTouched = ref(false);

const previewImage = computed(() => stagedImage.value ?? sandbox.active.value?.image ?? undefined);

const pickFile = async (event: Event): Promise<void> => {
    const file = (event.target as HTMLInputElement).files?.[0];
    (event.target as HTMLInputElement).value = ``;
    if (file === undefined) {
        return;
    }
    error.value = undefined;
    try {
        stagedImage.value = await fileToSquareDataUrl(file);
    } catch {
        error.value = `Couldn't read that file as an image.`;
    }
};

const canSave = computed(() => {
    const trimmed = name.value.trim();
    return trimmed.length > 0 && trimmed.length <= 60 && (trimmed !== sandbox.active.value?.name || stagedImage.value !== undefined);
});

const nameError = computed<string | undefined>(() => {
    const trimmed = name.value.trim();
    if (trimmed.length === 0) return `Name is required.`;
    if (trimmed.length > 60) return `Name must be 60 characters or fewer.`;
    return undefined;
});

const save = async (): Promise<void> => {
    const trimmed = name.value.trim();
    if (busy.value || !canSave.value) {
        return;
    }
    busy.value = true;
    error.value = undefined;
    try {
        await sandbox.update({
            ...(trimmed !== sandbox.active.value?.name && { name: trimmed }),
            ...(stagedImage.value !== undefined && { image: stagedImage.value }),
        });
        visible.value = false;
    } catch (err) {
        error.value = err instanceof Error ? err.message : `Couldn't save sandbox settings.`;
    } finally {
        busy.value = false;
    }
};
</script>

<template>
    <Dialog v-model:visible="visible" :modal="true" :draggable="false" :dismissable-mask="true" :style="{ width: '30rem' }" header="Sandbox settings">
        <div v-if="error" :class="cmp.alertDanger('mb-3')">{{ error }}</div>

        <form class="flex flex-col gap-4" @submit.prevent="save">
            <div class="flex items-center gap-3">
                <span class="flex h-16 w-16 shrink-0 items-center justify-center overflow-hidden rounded-lg border border-line bg-card text-muted">
                    <img v-if="previewImage" :src="previewImage" alt="" class="h-full w-full object-cover" />
                    <span v-else-if="name.trim()" class="text-xl font-semibold uppercase text-content">{{ name.trim().charAt(0) }}</span>
                    <Icon name="server" v-else class="text-xl" />
                </span>
                <div class="flex flex-col items-start gap-1">
                    <Button label="Choose image" severity="secondary" :outlined="true" size="small" @click="fileInput?.click()">
                        <template #icon><Icon name="image" /></template>
                    </Button>
                    <span class="text-2xs text-subtle">Cropped to a square and shown in the sandbox switcher.</span>
                </div>
                <input ref="fileInput" type="file" accept="image/*" class="hidden" @change="pickFile" />
            </div>

            <label class="flex flex-col gap-1">
                <span class="text-xs font-medium text-muted">Name</span>
                <input
                    v-model="name"
                    type="text"
                    autocomplete="off"
                    maxlength="60"
                    :class="[cmp.input('w-full'), nameTouched && nameError ? 'ui-field-input-error' : '']"
                    @blur="nameTouched = true"
                />
                <span v-if="nameTouched && nameError" class="ui-field-error">
                    <Icon name="exclamation-triangle" class="text-2xs" />
                    {{ nameError }}
                </span>
            </label>

            <div class="flex justify-end">
                <Button type="submit" label="Save" :loading="busy" :disabled="busy || !canSave" />
            </div>
        </form>
    </Dialog>
</template>
