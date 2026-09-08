<script setup lang="ts">
import { Button, ui, Notice, type NoticeModel } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import type { InvitePreview } from "@intentic/api-contract";
import { computed, onMounted, ref } from "vue";
import { RouterLink, useRoute, useRouter } from "vue-router";
import { apiClient } from "../../lib/useApi";
import { useAuth } from "../auth/useAuth";
import { useSandbox } from "../sandbox/client/useSandbox";
import AppBrand from "../../components/AppBrand.vue";

// Public accept-invite landing for /invite/:token: previews the token without a session, resolves the current session,
// then routes the invitee (sign in as the invited address, accept, into the workspace). Accept is email-locked
// server-side; this page only picks the right prompt for token × session.

const route = useRoute();
const router = useRouter();
const { user, refresh, signInWithGoogle, signOut } = useAuth();
const sandbox = useSandbox();

const token = String(route.params[`token`]);
const preview = ref<InvitePreview>();
const loading = ref(true);
const busy = ref(false);
const error = ref<NoticeModel>();

onMounted(async () => {
    // Session refresh and token preview are independent (preview needs no session): resolve them together.
    const [, previewed] = await Promise.all([refresh(), apiClient.invite.preview({ token }).catch(() => ({ status: `invalid` as const }))]);
    preview.value = previewed;
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
                <Button label="Continue with Google" severity="secondary" class="mt-6 w-full justify-center" @click="signIn">
                    <template #icon><Icon name="google" /></template>
                </Button>
            </template>

            <template v-else-if="view === 'accept'">
                <h2 class="text-2xl font-semibold tracking-tight">You're invited</h2>
                <p class="mt-2 text-sm text-muted">
                    You've been invited to the <span class="font-medium text-content">{{ sandboxName }}</span> sandbox, to {{ grantSentence }}.
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
                <Button label="Switch account" severity="secondary" class="mt-6 w-full justify-center" @click="switchAccount">
                    <template #icon><Icon name="sync" /></template>
                </Button>
            </template>

            <template v-else>
                <h2 class="text-2xl font-semibold tracking-tight">You're all set</h2>
                <p class="mt-2 text-sm text-muted">
                    You already have access to <span class="font-medium text-content">{{ sandboxName }}</span
                    >.
                </p>
                <Button :as="RouterLink" to="/" label="Open sandbox" class="mt-6 w-full justify-center">
                    <template #icon><Icon name="arrow-right" /></template>
                </Button>
            </template>

            <Notice v-if="error" :of="error" class="mt-4" />
        </div>
    </div>
</template>
