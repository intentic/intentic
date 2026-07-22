<script setup lang="ts">
import { cmp } from "@intentic-app/ui";
import type { InvitePreview } from "@intentic-app/api-contract";
import Button from "primevue/button";
import { computed, onMounted, ref } from "vue";
import { useRoute, useRouter } from "vue-router";
import { apiClient } from "../composables/useApi";
import { errorMessage } from "../composables/useAsyncAction";
import { useAuth } from "../composables/useAuth";
import { useSandbox } from "../composables/sandbox/useSandbox";

/* Public accept-invite landing for the emailed link (/invite/:token). It previews the token (no session needed),
 * resolves the current session, then routes the invitee: sign in as the invited address → accept → into the
 * workspace. Accept is email-locked server-side; this page just picks the right prompt for the token × session. */

const route = useRoute();
const router = useRouter();
const { user, refresh, signInWithGoogle, signOut } = useAuth();
const sandbox = useSandbox();

const token = String(route.params[`token`]);
const preview = ref<InvitePreview>();
const loading = ref(true);
const busy = ref(false);
const error = ref<string>();

onMounted(async () => {
    // Session refresh and token preview are independent (preview needs no session) — resolve them together.
    const [, previewed] = await Promise.all([refresh(), apiClient.invite.preview({ token }).catch(() => ({ status: `invalid` as const }))]);
    preview.value = previewed;
    loading.value = false;
});

const invitedEmail = computed(() => preview.value?.invitedEmail);
const sandboxName = computed(() => preview.value?.sandboxName);
const emailMatches = computed(() => invitedEmail.value !== undefined && user.value?.email.toLowerCase() === invitedEmail.value);

// The single thing to render, derived from the token's state × the current session.
const view = computed(() => {
    if (loading.value) {
        return `loading`;
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
        error.value = errorMessage(err, `Couldn't accept the invite.`);
        busy.value = false;
    }
};

const open = (): Promise<unknown> => router.push(`/`);

const switchAccount = async (): Promise<void> => {
    await signOut();
    await signIn();
};
</script>

<template>
    <div class="flex min-h-screen w-full items-center justify-center bg-canvas p-6 text-content">
        <div class="animate-fade-in w-full max-w-sm">
            <img src="/assets/intentic-full.png" alt="intentic platform" class="mb-10 h-8 w-auto" />

            <div v-if="view === 'loading'" class="flex items-center gap-3 text-sm text-muted">
                <Icon name="spinner" spin />
                <span>Loading your invite…</span>
            </div>

            <template v-else-if="view === 'invalid'">
                <h2 class="text-2xl font-semibold tracking-tight">Invite not found</h2>
                <p class="mt-2 text-sm text-muted">This invite link is invalid or has been revoked. Ask whoever invited you for a fresh link.</p>
            </template>

            <template v-else-if="view === 'expired'">
                <h2 class="text-2xl font-semibold tracking-tight">Invite expired</h2>
                <p class="mt-2 text-sm text-muted">This invite link has expired. Ask whoever invited you to send a new one.</p>
            </template>

            <template v-else-if="view === 'signin'">
                <h2 class="text-2xl font-semibold tracking-tight">You're invited</h2>
                <p class="mt-2 text-sm text-muted">
                    You've been invited to open the <span class="font-medium text-content">{{ sandboxName }}</span> sandbox. Sign in with Google as
                    <span class="font-medium text-content">{{ invitedEmail }}</span> to continue.
                </p>
                <Button label="Continue with Google" severity="secondary" :outlined="true" class="mt-6 w-full justify-center" @click="signIn">
                    <template #icon><Icon name="google" /></template>
                </Button>
            </template>

            <template v-else-if="view === 'accept'">
                <h2 class="text-2xl font-semibold tracking-tight">You're invited</h2>
                <p class="mt-2 text-sm text-muted">
                    You've been invited to open and work in the <span class="font-medium text-content">{{ sandboxName }}</span> sandbox.
                </p>
                <Button label="Accept invitation" class="mt-6 w-full justify-center" :loading="busy" @click="accept">
                    <template #icon><Icon name="check" /></template>
                </Button>
            </template>

            <template v-else-if="view === 'wrong-account'">
                <h2 class="text-2xl font-semibold tracking-tight">Wrong account</h2>
                <p class="mt-2 text-sm text-muted">
                    This invite is for <span class="font-medium text-content">{{ invitedEmail }}</span
                    >, but you're signed in as <span class="font-medium text-content">{{ user?.email }}</span
                    >. Switch accounts to accept it.
                </p>
                <Button label="Switch account" severity="secondary" :outlined="true" class="mt-6 w-full justify-center" @click="switchAccount">
                    <template #icon><Icon name="sync" /></template>
                </Button>
            </template>

            <template v-else>
                <h2 class="text-2xl font-semibold tracking-tight">You're all set</h2>
                <p class="mt-2 text-sm text-muted">
                    You already have access to <span class="font-medium text-content">{{ sandboxName }}</span
                    >.
                </p>
                <Button label="Open sandbox" class="mt-6 w-full justify-center" @click="open">
                    <template #icon><Icon name="arrow-right" /></template>
                </Button>
            </template>

            <div v-if="error" :class="cmp.alertDanger('mt-4')">{{ error }}</div>
        </div>
    </div>
</template>
