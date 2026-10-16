<script setup lang="ts">
import { Button } from "@intentic/ui";
import { EMAIL_SIGN_IN_OFF } from "@intentic/sandbox-contract/schemas/system";
import GateCard from "./GateCard.vue";
import { computed } from "vue";
import { useAuth } from "../../../client/auth/useAuth";
import { emailOnly } from "../../../client/auth/signInMethods";
import { useGoogleIdentity } from "../../../client/auth/useGoogleIdentity";
import { useSandboxSession } from "../../../client/session/sandboxSession";
import { useSandbox } from "../../../client/sandbox/useSandbox";
import { desktopVersion, signInThroughBrowser } from "../../../app/environments/desktop";
import { useT } from "@intentic/ui/i18n";

// Shown when the daemon is up but rejects the signed-in account with 403: neither owner nor a granted member, or a
// member this sandbox has not opted in to email sign-in (the daemon's EMAIL_SIGN_IN_OFF). No spinner and no 'Open
// setup', since waiting won't fix either; the liveness loop keeps retrying, so a grant (or the owner's opt-in) clears
// this screen by itself.

const t = useT();

const { active } = useSandbox();
const { user } = useAuth();
const { clearCredential, getIdToken } = useGoogleIdentity();
const { presentedEmail, invalidateSession, getSessionToken, emailRefusal, retryEmailSignIn } = useSandboxSession();

// The sandbox took the platform's word for the address and still said no: only its owner can turn email sign-in on.
const emailSignInOff = computed(() => emailRefusal.value === EMAIL_SIGN_IN_OFF);
// An account with no Google sign-in has no Google account to switch to; its way on is asking again once the owner acts.
const withoutGoogle = computed(() => emailOnly(user.value?.signInMethods));

// The Google identity the daemon saw differs from the user's intentic account; usually two Google accounts.
const wrongGoogleAccount = computed(
    () =>
        user.value?.email !== undefined &&
        presentedEmail.value !== undefined &&
        user.value.email.toLowerCase() !== presentedEmail.value.toLowerCase(),
);

const title = computed(() => t(`sandbox.sandboxUnauthorized.noAccessTo`, { name: active.value?.name ?? `` }));

// Clears both the 403 session and the Google credential, then re-establishes through Google's ACCOUNT CHOOSER —
// which is the whole of what this button means, and the part that used to be dropped: Google answers with the
// account already approved here unless it is told not to, so a press landed back on the same refusal.
// In the app's own window nothing can ask Google at all, so the press goes straight to the browser hand-off
// carrying the same intent; raising the shared sign-in gate first only put a second dialog in front of one road.
// Asks again at once, past the pause a refusal only the owner can lift puts on new attempts (sandboxSession.ts).
const tryAgain = async (): Promise<void> => {
    retryEmailSignIn();
    invalidateSession();
    await getSessionToken();
};

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
        <i18n-t v-if="emailSignInOff" keypath="sandbox.sandboxUnauthorized.emailSignInOff" tag="p" class="text-sm text-muted" scope="global">
            <template #email
                ><span class="font-medium text-content">{{ user?.email }}</span></template
            >
        </i18n-t>
        <i18n-t v-else-if="wrongGoogleAccount" keypath="sandbox.sandboxUnauthorized.wrongGoogleAccount" tag="p" class="text-sm text-muted" scope="global">
            <template #presented
                ><span class="font-medium text-content">{{ presentedEmail }}</span></template
            >
            <template #account
                ><span class="font-medium text-content">{{ user?.email }}</span></template
            >
        </i18n-t>
        <i18n-t v-else keypath="sandbox.sandboxUnauthorized.notShared" tag="p" class="text-sm text-muted" scope="global">
            <template #presented
                ><span class="font-medium text-content">{{ presentedEmail ?? user?.email }}</span></template
            >
        </i18n-t>
        <template #actions>
            <Button v-if="emailSignInOff || withoutGoogle" :label="t(`ui.action.tryAgain`)" tier="boring" @click="tryAgain">
                <template #icon><Icon name="refresh" /></template>
            </Button>
            <Button v-else :label="t(`sandbox.sandboxUnauthorized.switchGoogleAccount`)" tier="boring" @click="switchAccount">
                <template #icon><Icon name="user" /></template>
            </Button>
        </template>
    </GateCard>
</template>
