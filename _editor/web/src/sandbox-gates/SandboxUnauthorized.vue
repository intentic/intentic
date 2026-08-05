<script setup lang="ts">
import Button from "primevue/button";
import GateCard from "./GateCard.vue";
import { computed } from "vue";
import { useAuth } from "../composables/useAuth";
import { useGoogleIdentity } from "../composables/useGoogleIdentity";
import { useSandboxSession } from "../composables/sandbox/sandboxSession";
import { useSandbox } from "../composables/sandbox/useSandbox";

/* Shown in the workspace outlet when the daemon is UP but rejects the signed-in Google account with 403 —
 * the account is neither the sandbox's owner nor a granted member (see useSandboxLiveness). Distinct from
 * the connecting gate on purpose: waiting won't fix an account mismatch, so no spinner and no "Open setup".
 * Two shapes: you're on the WRONG Google account (≠ your intentic account) → sign in with your account; or
 * you're on your own account but this is someone else's sandbox → ask its owner. The liveness loop keeps
 * retrying in the background, so a grant (or a switch) clears this screen by itself within seconds. */

const { active } = useSandbox();
const { user } = useAuth();
const { clearCredential } = useGoogleIdentity();
const { presentedEmail, invalidateSession, getSessionToken } = useSandboxSession();

// The identity the daemon saw isn't the account the user registered with — the common cause (they have two
// Google accounts). Since platform login is Google-only, the intentic email is the account to sign in with.
const wrongGoogleAccount = computed(
    () =>
        user.value?.email !== undefined &&
        presentedEmail.value !== undefined &&
        user.value.email.toLowerCase() !== presentedEmail.value.toLowerCase(),
);

// Drop both credentials — the daemon session the 403 was minted for AND the Google credential behind it — and
// immediately re-establish: the sign-in gate overlays with Google's account picker (clearCredential disables
// auto-select), and the liveness retries share the same in-flight establish.
const title = computed(() => `No access to "${active.value?.name}"`);

const switchAccount = (): void => {
    clearCredential();
    invalidateSession();
    void getSessionToken();
};
</script>

<template>
    <GateCard icon="lock" :title="title">
        <p v-if="wrongGoogleAccount" class="text-sm text-muted">
            You're signed into Google as <span class="font-medium text-content">{{ presentedEmail }}</span
            >, but your intentic account is <span class="font-medium text-content">{{ user?.email }}</span
            >. Sign in with <span class="font-medium text-content">{{ user?.email }}</span> to open this sandbox.
        </p>
        <p v-else class="text-sm text-muted">
            This sandbox belongs to another account and hasn't shared access with
            <span class="font-medium text-content">{{ presentedEmail }}</span
            >. Ask its owner to grant you access — this clears automatically the moment it's granted.
        </p>
        <template #actions>
            <Button label="Switch Google account" severity="secondary" @click="switchAccount">
                <template #icon><Icon name="user" /></template>
            </Button>
        </template>
    </GateCard>
</template>
