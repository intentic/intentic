<script setup lang="ts">
import { Button } from "@intentic/ui";
import GateCard from "./GateCard.vue";
import { computed } from "vue";
import { useAuth } from "../../auth/useAuth";
import { useGoogleIdentity } from "../../auth/useGoogleIdentity";
import { useSandboxSession } from "../session/sandboxSession";
import { useSandbox } from "../client/useSandbox";
import { desktopVersion, signInThroughBrowser } from "../../../app/environments/desktop";
import { useT } from "@intentic/ui/i18n";

// Shown when the daemon is up but rejects the signed-in Google account with 403: neither owner nor a granted
// member. No spinner and no 'Open setup', since waiting won't fix an account mismatch; the liveness loop keeps
// retrying, so a grant clears this screen by itself.

const t = useT();

const { active } = useSandbox();
const { user } = useAuth();
const { clearCredential, getIdToken } = useGoogleIdentity();
const { presentedEmail, invalidateSession, getSessionToken } = useSandboxSession();

// The Google identity the daemon saw differs from the user's intentic account; usually two Google accounts.
const wrongGoogleAccount = computed(
    () =>
        user.value?.email !== undefined &&
        presentedEmail.value !== undefined &&
        user.value.email.toLowerCase() !== presentedEmail.value.toLowerCase(),
);

const title = computed(() => `No access to "${active.value?.name}"`);

// Clears both the 403 session and the Google credential, then re-establishes through Google's ACCOUNT CHOOSER —
// which is the whole of what this button means, and the part that used to be dropped: Google answers with the
// account already approved here unless it is told not to, so a press landed back on the same refusal.
// In the app's own window nothing can ask Google at all, so the press goes straight to the browser hand-off
// carrying the same intent; raising the shared sign-in gate first only put a second dialog in front of one road.
const switchAccount = async (): Promise<void> => {
    clearCredential();
    invalidateSession();
    if (desktopVersion() !== undefined) {
        signInThroughBrowser({ pickAccount: true });
        return;
    }
    // Awaited, not fired and forgotten: the promise is what holds the button while the chooser is up. The session
    // then establishes off whatever credential comes back, so a dismissed chooser changes nothing.
    if ((await getIdToken({ pick: true })) === undefined) {
        return;
    }
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
