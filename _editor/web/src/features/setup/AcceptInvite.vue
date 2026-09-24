<script setup lang="ts">
import { AppBrand, Button, Notice, type NoticeModel, ui } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import type { InvitePreview } from "@intentic/api-contract";
import { computed, onMounted, ref } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import { apiClient } from "../../lib/useApi";
import { useAuth } from "../auth/useAuth";
import { useSandbox } from "../sandbox/client/useSandbox";
import { useT } from "@intentic/ui/i18n";

// Public accept-invite landing for /invite/:token: previews the token without a session, resolves the current session,
// then routes the invitee (sign in as the invited address, accept, into the workspace). Accept is email-locked
// server-side; this page only picks the right prompt for token × session.

const t = useT();

const route = useRoute();
const router = useRouter();
const { user, refresh, signInWithGoogle, signOut } = useAuth();
const sandbox = useSandbox();

const token = String(route.params[`token`]);
const preview = ref<InvitePreview>();
const loading = ref(true);
const previewFailed = ref(false);
const busy = ref(false);
const error = ref<NoticeModel>();

onMounted(async () => {
    // Session refresh and token preview are independent (preview needs no session): resolve them together. The platform
    // answers a bad token in-band, so a preview that throws is an unanswered question, never an invalid invite.
    const [session, previewed] = await Promise.allSettled([refresh(), apiClient.invite.preview({ token })]);
    if (previewed.status === `fulfilled`) {
        preview.value = previewed.value;
    } else {
        previewFailed.value = true;
        error.value = noticeFrom(previewed.reason, `Couldn't check this invite. Reload the page to try again.`);
    }
    if (session.status === `rejected`) {
        error.value ??= noticeFrom(session.reason, `Couldn't check who's signed in. Reload the page to try again.`);
    }
    loading.value = false;
});

const invitedEmail = computed(() => preview.value?.invitedEmail);
const sandboxName = computed(() => preview.value?.sandboxName);
// States what the invitee's role grants; an absent role falls back to what every tier can do.
const grantSentence = computed<string>(() => {
    switch (preview.value?.role) {
        case `maintainer`: {
            return `work in it and operate it, alongside its owner`;
        }
        case `collaborator`: {
            return `read it and put its agents to work; landing and the box's own settings stay with its owner`;
        }
        case `viewer`: {
            return `follow along: read the files and watch the agents work, without changing anything`;
        }
        case `guest`: {
            return `talk to the assistants its owner picked for you; nothing else in it is shown`;
        }
        default: {
            return `open it`;
        }
    }
});
const emailMatches = computed(() => invitedEmail.value !== undefined && user.value?.email.toLowerCase() === invitedEmail.value);

// The single thing to render, derived from the token's state × the current session.
const view = computed(() => {
    if (loading.value) {
        return `loading`;
    }
    if (previewFailed.value) {
        return `unchecked`;
    }
    const status = preview.value?.status ?? `invalid`;
    if (status === `invalid` || status === `expired`) {
        return status;
    }
    if (status === `accepted`) {
        return emailMatches.value ? `open` : `signin`;
    }
    if (!user.value) {
        return `signin`;
    }
    return emailMatches.value ? `accept` : `wrong-account`;
});

const signIn = (): Promise<void> => signInWithGoogle(`/invite/${token}`);

const accept = async (): Promise<void> => {
    if (busy.value) {
        return;
    }
    busy.value = true;
    error.value = undefined;
    try {
        const { sandboxId } = await apiClient.invite.accept({ token });
        await sandbox.refresh();
        sandbox.select(sandboxId);
        await router.push(`/`);
    } catch (err) {
        error.value = noticeFrom(err, `Couldn't accept the invite.`);
        busy.value = false;
    }
};

// The workspace is a place, so opening it is a link, not a click handler.

const switchAccount = async (): Promise<void> => {
    await signOut();
    await signIn();
};
</script>

<template>
    <div class="flex min-h-screen w-full items-center justify-center bg-canvas p-6 text-content">
        <div class="w-full max-w-sm">
            <AppBrand class="mb-10 text-2xl" />

            <div v-if="view === 'loading'" class="flex items-center gap-3 text-sm text-muted">
                <Icon name="spinner" spin />
                <span>{{ t(`setup.acceptInvite.loadingInvite`) }}</span>
            </div>

            <!-- Nothing to say about the invite itself; the notice below says why. -->
            <template v-else-if="view === 'unchecked'" />

            <template v-else-if="view === 'invalid'">
                <h2 class="text-2xl font-semibold tracking-tight">{{ t(`setup.acceptInvite.inviteNotFound`) }}</h2>
                <p class="mt-2 text-sm text-muted">{{ t(`setup.acceptInvite.inviteLinkInvalidRevoked`) }}</p>
            </template>

            <template v-else-if="view === 'expired'">
                <h2 class="text-2xl font-semibold tracking-tight">{{ t(`setup.acceptInvite.inviteExpired`) }}</h2>
                <p class="mt-2 text-sm text-muted">{{ t(`setup.acceptInvite.inviteLinkExpiredAsk`) }}</p>
            </template>

            <template v-else-if="view === 'signin'">
                <h2 class="text-2xl font-semibold tracking-tight">{{ t(`setup.acceptInvite.youreInvited`) }}</h2>
                <i18n-t keypath="setup.acceptInvite.invitedToOpenSandbox" tag="p" class="mt-2 text-sm text-muted" scope="global">
                    <template #sandbox
                        ><span class="font-medium text-content">{{ sandboxName }}</span></template
                    >
                    <template #email
                        ><span class="font-medium text-content">{{ invitedEmail }}</span></template
                    >
                </i18n-t>
                <Button :label="t(`shared.continueGoogle`)" severity="secondary" class="mt-6 w-full justify-center" @click="signIn">
                    <template #icon><Icon name="google" /></template>
                </Button>
            </template>

            <template v-else-if="view === 'accept'">
                <h2 class="text-2xl font-semibold tracking-tight">{{ t(`setup.acceptInvite.youreInvited`) }}</h2>
                <i18n-t keypath="setup.acceptInvite.invitedToSandboxTo" tag="p" class="mt-2 text-sm text-muted" scope="global">
                    <template #sandbox
                        ><span class="font-medium text-content">{{ sandboxName }}</span></template
                    >
                    <template #grant>{{ grantSentence }}</template>
                </i18n-t>
                <Button :label="t(`setup.acceptInvite.acceptInvitation`)" class="mt-6 w-full justify-center" :loading="busy" @click="accept">
                    <template #icon><Icon name="check" /></template>
                </Button>
            </template>

            <template v-else-if="view === 'wrong-account'">
                <h2 class="text-2xl font-semibold tracking-tight">{{ t(`setup.acceptInvite.wrongAccount`) }}</h2>
                <i18n-t keypath="setup.acceptInvite.inviteIsForButSignedIn" tag="p" class="mt-2 text-sm text-muted" scope="global">
                    <template #invited
                        ><span class="font-medium text-content">{{ invitedEmail }}</span></template
                    >
                    <template #current
                        ><span class="font-medium text-content">{{ user?.email }}</span></template
                    >
                </i18n-t>
                <Button :label="t(`shared.switchAccount`)" severity="secondary" class="mt-6 w-full justify-center" @click="switchAccount">
                    <template #icon><Icon name="sync" /></template>
                </Button>
            </template>

            <template v-else>
                <h2 class="text-2xl font-semibold tracking-tight">{{ t(`setup.acceptInvite.youreAllSet`) }}</h2>
                <i18n-t keypath="setup.acceptInvite.alreadyHaveAccessTo" tag="p" class="mt-2 text-sm text-muted" scope="global">
                    <template #sandbox
                        ><span class="font-medium text-content">{{ sandboxName }}</span></template
                    >
                </i18n-t>
                <Button :as="RouterLink" to="/" :label="t(`setup.acceptInvite.openSandbox`)" class="mt-6 w-full justify-center">
                    <template #icon><Icon name="arrow-right" /></template>
                </Button>
            </template>

            <Notice v-if="error" :of="error" class="mt-4" />
        </div>
    </div>
</template>
