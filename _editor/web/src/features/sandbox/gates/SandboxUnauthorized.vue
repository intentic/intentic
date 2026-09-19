<script setup lang="ts">
import { Button } from "@intentic/ui";
import GateCard from "./GateCard.vue";
import { computed } from "vue";
import { useAuth } from "../../auth/useAuth";
import { useGoogleIdentity } from "../../auth/useGoogleIdentity";
import { useSandboxSession } from "../session/sandboxSession";
import { useSandbox } from "../client/useSandbox";
import { useT } from "@intentic/ui/i18n";

// Shown when the daemon is up but rejects the signed-in Google account with 403: neither owner nor a granted
// member. No spinner and no 'Open setup', since waiting won't fix an account mismatch; the liveness loop keeps
// retrying, so a grant clears this screen by itself.

const t = useT();

const { active } = useSandbox();
const { user } = useAuth();
const { clearCredential } = useGoogleIdentity();
const { presentedEmail, invalidateSession, getSessionToken } = useSandboxSession();

// The Google identity the daemon saw differs from the user's intentic account; usually two Google accounts.
const wrongGoogleAccount = computed(
    () =>
        user.value?.email !== undefined &&
        presentedEmail.value !== undefined &&
        user.value.email.toLowerCase() !== presentedEmail.value.toLowerCase(),
);

// Clears both the 403 session and the Google credential, then re-establishes through the account picker.
const title = computed(() => `No access to "${active.value?.name}"`);

const switchAccount = async (): Promise<void> => {
    clearCredential();
    invalidateSession();
    // Awaited, not fired and forgotten: the promise is what holds the button while the token is fetched.
    await getSessionToken();
};
</script>

<template>
    <GateCard icon="lock" :title="title">
        <p v-if="wrongGoogleAccount" class="text-sm text-muted">
            {{ t(`sandbox.sandboxUnauthorized.youreSignedIntoGoogle`) }} <span class="font-medium text-content">{{ presentedEmail }}</span
            >{{ t(`sandbox.sandboxUnauthorized.intenticAccount`) }} <span class="font-medium text-content">{{ user?.email }}</span
            >. Sign in with <span class="font-medium text-content">{{ user?.email }}</span> {{ t(`sandbox.sandboxUnauthorized.toOpenSandbox`) }}
        </p>
        <p v-else class="text-sm text-muted">
            {{ t(`sandbox.sandboxUnauthorized.sandboxBelongsToAnother`) }}
            <span class="font-medium text-content">{{ presentedEmail }}</span
            >. Ask its owner to grant you access: this clears automatically the moment it's granted.
        </p>
        <template #actions>
            <Button :label="t(`sandbox.sandboxUnauthorized.switchGoogleAccount`)" severity="secondary" @click="switchAccount">
                <template #icon><Icon name="user" /></template>
            </Button>
        </template>
    </GateCard>
</template>
