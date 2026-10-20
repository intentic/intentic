<script setup lang="ts">
import { AppBrand, Button, Notice, type NoticeModel, ui } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import type { InvitePreview, SignInOptions } from "@intentic/api-contract";
import { computed, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { apiClient } from "../../lib/useApi";
import { useAuth } from "../../client/auth/useAuth";
import { useSandbox } from "../../client/sandbox/useSandbox";
import { desktopVersion } from "../../app/environments/desktop";
import { inNativeShell } from "../../workbench/window/capacitor";
import EmailCodeSignIn from "../auth/EmailCodeSignIn.vue";
import { GOOGLE_ONLY, readSignInOptions } from "../auth/signInOptions";
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
// Which ways in the platform offers: an invited address on a domain Google holds no account for signs in with a code.
const options = ref<SignInOptions>(GOOGLE_ONLY);
// The desktop app's webview or the iOS shell, where the mail's link opens elsewhere and the code is typed instead.
const inApp = desktopVersion() !== undefined || inNativeShell();

onMounted(async () => {
    // Session refresh, token preview and the platform's ways in are independent (none needs a session): resolve them
    // together. The platform answers a bad token in-band, so a preview that throws is an unanswered question, never an
    // invalid invite.
    const [session, previewed, offered] = await Promise.allSettled([refresh(), apiClient.invite.preview({ token }), readSignInOptions()]);
    if (offered.status === `fulfilled`) {
        options.value = offered.value;
    }
    if (previewed.status === `fulfilled`) {
        preview.value = previewed.value;
    } else {
        previewFailed.value = true;
        error.value = noticeFrom(previewed.reason, t(`setup.acceptInvite.couldntCheckInvite`));
    }
    if (session.status === `rejected`) {
        error.value ??= noticeFrom(session.reason, t(`setup.acceptInvite.couldntCheckSession`));
    }
    loading.value = false;
});

const invitedEmail = computed(() => preview.value?.invitedEmail);
const sandboxName = computed(() => preview.value?.sandboxName);
// States what the invitee's role grants; an absent role falls back to what every tier can do.
const grantSentence = computed<string>(() => {
    switch (preview.value?.role) {
        case `maintainer`: {
            return t(`setup.acceptInvite.grantMaintainer`);
        }
        case `collaborator`: {
            return t(`setup.acceptInvite.grantCollaborator`);
        }
        case `viewer`: {
            return t(`setup.acceptInvite.grantViewer`);
        }
        case `guest`: {
            return t(`setup.acceptInvite.grantGuest`);
        }
        default: {
            return t(`setup.acceptInvite.grantDefault`);
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
        error.value = noticeFrom(err, t(`setup.acceptInvite.couldntAccept`));
        busy.value = false;
    }
};

// Opening an invite already accepted goes through `accept` as well, which the platform answers again with the sandbox's
// id ("idempotent once accepted"): a plain link to `/` opened whichever sandbox this browser had open last, so a member
// with a sandbox of their own landed there rather than in the one the invite names.

// With a code on offer the reader is brought back to this page signed out, to pick either way in as the invited address;
// otherwise Google's own page is the one road, as before.
const switchAccount = async (): Promise<void> => {
    await signOut();
    if (options.value.email) {
        // Signing out sends a stale shell to /login (App.vue); the invite is still the page this reader is on.
        await router.replace(`/invite/${token}`);
        return;
    }
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
                <!-- Method-neutral where a code is offered too; Google's own words where it is the only way in. -->
                <i18n-t v-if="options.email" keypath="setup.acceptInvite.invitedToOpenSandboxAs" tag="p" class="mt-2 text-sm text-muted" scope="global">
                    <template #sandbox
                        ><span class="font-medium text-content">{{ sandboxName }}</span></template
                    >
                    <template #email
                        ><span class="font-medium text-content">{{ invitedEmail }}</span></template
                    >
                </i18n-t>
                <i18n-t v-else keypath="setup.acceptInvite.invitedToOpenSandbox" tag="p" class="mt-2 text-sm text-muted" scope="global">
                    <template #sandbox
                        ><span class="font-medium text-content">{{ sandboxName }}</span></template
                    >
                    <template #email
                        ><span class="font-medium text-content">{{ invitedEmail }}</span></template
                    >
                </i18n-t>
                <Button v-if="options.google" :label="t(`auth.words.continueGoogle`)" tier="boring" class="mt-6 w-full justify-center" @click="signIn">
                    <template #icon><Icon name="google" /></template>
                </Button>
                <!-- The invited address, locked: the platform accepts this invite for no other, so no other is offered. -->
                <template v-if="options.email && invitedEmail !== undefined">
                    <span v-if="options.google" class="my-3 block text-center text-2xs text-subtle">{{
                        t(`auth.login.or`)
                    }}</span>
                    <EmailCodeSignIn :class="options.google ? `` : `mt-6`" :locked-email="invitedEmail" :in-app="inApp" />
                </template>
                <!-- The clickwrap, before anything is sent: a first sign-in from here makes the account. -->
                <p class="mt-4 text-2xs leading-relaxed text-subtle">
                    {{ t(`auth.login.weKeepEmailAddress`) }}
                    <a href="https://intentic.dev/terms/" target="_blank" rel="noopener" class="text-link hover:underline">{{ t(`auth.login.terms`) }}</a
                    >,
                    <a href="https://intentic.dev/acceptable-use/" target="_blank" rel="noopener" class="text-link hover:underline">{{
                        t(`auth.login.acceptableUsePolicy`)
                    }}</a>
                    {{ t(`auth.login.and`) }}
                    <a href="https://intentic.dev/privacy/" target="_blank" rel="noopener" class="text-link hover:underline">{{ t(`auth.login.privacyPolicy`) }}</a
                    >.
                </p>
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
                <Button :label="t(`shell.words.switchAccount`)" tier="boring" class="mt-6 w-full justify-center" @click="switchAccount">
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
                <Button :label="t(`setup.acceptInvite.openSandbox`)" class="mt-6 w-full justify-center" :loading="busy" @click="accept">
                    <template #icon><Icon name="arrow-right" /></template>
                </Button>
            </template>

            <Notice v-if="error" :of="error" class="mt-4" />
        </div>
    </div>
</template>
