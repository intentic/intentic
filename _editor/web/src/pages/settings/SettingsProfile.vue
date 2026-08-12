<script setup lang="ts">
import { Avatar, Card, cmp } from "@intentic/ui";
import { errorMessage } from "@intentic/ui/async";
import Button from "primevue/button";
import { computed, ref } from "vue";
import { fileToSquareDataUrl } from "../../composables/imageDataUrl";
import { useAuth } from "../../composables/useAuth";
import { useDraft } from "../../composables/useDraft";

/* Profile: display name + avatar, saved via Better Auth's update-user (useAuth.updateProfile). The picked file
 * becomes a small square data URL in the browser — no upload. Re-seeded from the shared user ref, so a save
 * (which refreshes the session) syncs the form back to what the server stored. */

const { user, updateProfile } = useAuth();

// Seeded from the session's name and following a rename made elsewhere — but never over an edit in this form:
// refresh() rebuilds `user` as a fresh object on every call, so an unconditional re-seed here was one new
// refresh() caller away from wiping a half-typed name (see useDraft).
const profileName = useDraft(() => user.value?.name);
// A freshly picked avatar, previewed until Save sends it. Undefined = keep the current one.
const stagedAvatar = ref<string | undefined>(undefined);
const avatarInput = ref<HTMLInputElement | null>(null);
// A broken picture URL is <Avatar>'s problem, not this form's: it falls back on its own, so there is no
// load-failure flag to hold here any more.
const avatarImage = computed(() => stagedAvatar.value ?? user.value?.image);
const saving = ref(false);
const saveError = ref<string | undefined>(undefined);

const pickAvatar = async (event: Event): Promise<void> => {
    const file = (event.target as HTMLInputElement).files?.[0];
    (event.target as HTMLInputElement).value = ``;
    if (file === undefined) {
        return;
    }
    saveError.value = undefined;
    try {
        stagedAvatar.value = await fileToSquareDataUrl(file, `cover`);
    } catch {
        saveError.value = `Couldn't read that file as an image.`;
    }
};

const canSaveProfile = computed(() => {
    const trimmed = profileName.value.trim();
    return trimmed.length > 0 && trimmed.length <= 60 && (trimmed !== user.value?.name || stagedAvatar.value !== undefined);
});

const saveProfile = async (): Promise<void> => {
    const trimmed = profileName.value.trim();
    if (saving.value || !canSaveProfile.value) {
        return;
    }
    saving.value = true;
    saveError.value = undefined;
    try {
        await updateProfile({
            ...(trimmed !== user.value?.name && { name: trimmed }),
            ...(stagedAvatar.value !== undefined && { image: stagedAvatar.value }),
        });
        stagedAvatar.value = undefined;
    } catch (error) {
        saveError.value = errorMessage(error, `Profile update failed.`);
    } finally {
        saving.value = false;
    }
};
</script>

<template>
    <Card>
        <form @submit.prevent="saveProfile">
            <div class="flex items-center gap-2.5">
                <Icon name="user" class="text-lg text-muted" />
                <div>
                    <h2 class="font-semibold leading-tight">Profile</h2>
                    <p class="text-xs text-muted">Your display name and avatar on this platform.</p>
                </div>
            </div>
            <div class="mt-3 flex items-center gap-3">
                <Avatar :size="56" :src="avatarImage" />
                <Button label="Change avatar" severity="secondary" size="small" @click="avatarInput?.click()">
                    <template #icon><Icon name="image" /></template>
                </Button>
                <input ref="avatarInput" type="file" accept="image/*" class="hidden" @change="pickAvatar" />
            </div>
            <label class="mt-3 flex flex-col gap-1">
                <span class="text-xs font-medium text-muted">Display name</span>
                <input v-model="profileName" type="text" autocomplete="off" maxlength="60" :class="cmp.input('w-full')" />
            </label>
            <div class="mt-3 flex justify-end">
                <Button type="submit" label="Save" size="small" :loading="saving" :disabled="saving || !canSaveProfile" />
            </div>
            <p v-if="saveError" class="mt-2 text-2xs text-danger">{{ saveError }}</p>
        </form>
    </Card>
</template>
