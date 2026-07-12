<script setup lang="ts">
import { cmp } from "@intentic-app/ui";
import type { InviteRecord } from "@intentic-app/api-contract";
import Button from "primevue/button";
import Dialog from "primevue/dialog";
import { ref, watch } from "vue";
import { sandboxJson } from "../composables/sandboxClient";
import { apiClient, isPaymentRequired } from "../composables/useApi";
import { useAuth } from "../composables/useAuth";
import { useSandbox } from "../composables/useSandbox";

/* Owner-only invites for the ACTIVE sandbox. Inviting is two writes: the daemon's own authorized list
 * (sandboxJson → /members, the ENFORCED one — so an accepted invitee has access immediately) and the platform
 * invite record + email (apiClient.invite.create). The daemon write goes first — the server can't reach the
 * daemon, so the owner's browser pushes it; if the daemon rejects it or is offline the invite isn't recorded
 * (sandboxJson throws on any non-2xx, so a grant the enforcer never got is never recorded as sent — fail closed).
 * Resend is platform-only (the daemon already has the email); revoke removes from the daemon then the platform. */

const visible = defineModel<boolean>(`visible`, { default: false });

const { user, upgradeOpen } = useAuth();
const sandbox = useSandbox();

const members = ref<InviteRecord[]>([]);
const email = ref(``);
const busy = ref(false);
const error = ref<string>();
const emailTouched = ref(false);

const validEmail = (value: string): boolean => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value);

// Inviting is plan-gated: a PAYMENT_REQUIRED anywhere swaps this dialog for the upgrade one; anything else shows.
const gateOrError = (err: unknown, fallback: string): void => {
    if (isPaymentRequired(err)) {
        visible.value = false;
        upgradeOpen.value = true;
        return;
    }
    error.value = err instanceof Error ? err.message : fallback;
};

const badge = (status: InviteRecord["status"]): { label: string; class: string } => {
    if (status === `accepted`) {
        return { label: `Member`, class: `bg-primary-600/15 text-link` };
    }
    if (status === `expired`) {
        return { label: `Expired`, class: `bg-danger/10 text-danger` };
    }
    return { label: `Pending`, class: `bg-overlay text-muted` };
};

const load = async (): Promise<void> => {
    const id = sandbox.activeSandboxId.value;
    if (id === undefined) {
        return;
    }
    error.value = undefined;
    try {
        members.value = (await apiClient.invite.list({ sandboxId: id })).members;
    } catch (err) {
        gateOrError(err, `Couldn't load the access list.`);
    }
};

watch(visible, (open) => {
    if (open) {
        void load();
    }
});

const invite = async (): Promise<void> => {
    const id = sandbox.activeSandboxId.value;
    const value = email.value.trim().toLowerCase();
    if (id === undefined || busy.value || !validEmail(value)) {
        return;
    }
    busy.value = true;
    error.value = undefined;
    try {
        // Push to the daemon first (owner-gated, enforced), then record the invite + send the email. sandboxJson
        // throws on a non-2xx daemon reply (403/401/offline), so an unenforced grant is never recorded as sent.
        await sandboxJson<{ emails: string[] }>(`/members`, {
            method: `POST`,
            headers: { "content-type": `application/json` },
            body: JSON.stringify({ email: value }),
        });
        members.value = (await apiClient.invite.create({ sandboxId: id, email: value })).members;
        email.value = ``;
        emailTouched.value = false;
    } catch (err) {
        // The daemon push (or an offline sandbox) can fail before the invite is recorded; resync so a pending
        // invite created just before an email failure still shows with a Resend action.
        void load();
        gateOrError(err, `Couldn't send the invite — is the sandbox online?`);
    } finally {
        busy.value = false;
    }
};

const resend = async (target: string): Promise<void> => {
    const id = sandbox.activeSandboxId.value;
    if (id === undefined || busy.value) {
        return;
    }
    busy.value = true;
    error.value = undefined;
    try {
        members.value = (await apiClient.invite.resend({ sandboxId: id, email: target })).members;
    } catch (err) {
        gateOrError(err, `Couldn't resend the invite.`);
    } finally {
        busy.value = false;
    }
};

const revoke = async (target: string): Promise<void> => {
    const id = sandbox.activeSandboxId.value;
    if (id === undefined || busy.value) {
        return;
    }
    busy.value = true;
    error.value = undefined;
    try {
        // sandboxJson throws on a non-2xx daemon reply, so revoke reaches the enforcer before the platform row is
        // dropped — a daemon that rejects/is offline surfaces an error instead of a member who still has access.
        await sandboxJson<{ emails: string[] }>(`/members`, {
            method: `DELETE`,
            headers: { "content-type": `application/json` },
            body: JSON.stringify({ email: target }),
        });
        members.value = (await apiClient.invite.revoke({ sandboxId: id, email: target })).members;
    } catch (err) {
        gateOrError(err, `Couldn't revoke access — is the sandbox online?`);
    } finally {
        busy.value = false;
    }
};
</script>

<template>
    <Dialog v-model:visible="visible" :modal="true" :draggable="false" :dismissable-mask="true" :style="{ width: '30rem' }" header="Manage access">
        <p class="mb-4 text-sm text-muted">
            People you invite get an email with a link to open <span class="font-medium text-content">{{ sandbox.active.value?.name }}</span> — they
            accept and sign in with their own Google account.
        </p>

        <div v-if="error" :class="cmp.alertDanger('mb-3')">{{ error }}</div>

        <div class="flex flex-col gap-2">
            <div class="flex items-center gap-2.5 rounded-lg border border-line bg-card px-3 py-2">
                <Icon name="user" class="text-muted" />
                <span class="min-w-0 flex-1 truncate text-sm text-content">{{ user?.email }}</span>
                <span class="shrink-0 rounded-full bg-primary-600/15 px-1.5 py-0.5 text-2xs font-semibold text-link">Owner</span>
            </div>
            <div v-for="member in members" :key="member.email" class="flex items-center gap-2.5 rounded-lg border border-line bg-card px-3 py-2">
                <Icon name="user" class="text-muted" />
                <span class="min-w-0 flex-1 truncate text-sm text-content">{{ member.email }}</span>
                <span class="shrink-0 rounded-full px-1.5 py-0.5 text-2xs font-semibold" :class="badge(member.status).class">{{
                    badge(member.status).label
                }}</span>
                <Button
                    v-if="member.status !== 'accepted'"
                    label="Resend"
                    size="small"
                    severity="secondary"
                    :text="true"
                    :disabled="busy"
                    @click="resend(member.email)"
                />
                <Button
                    size="small"
                    severity="danger"
                    :text="true"
                    :rounded="true"
                    :disabled="busy"
                    aria-label="Revoke access"
                    @click="revoke(member.email)"
                >
                    <template #icon><Icon name="times" /></template>
                </Button>
            </div>
        </div>

        <form class="mt-4 flex flex-col gap-2" @submit.prevent="invite">
            <div class="flex items-center gap-2">
                <input
                    v-model="email"
                    type="email"
                    autocomplete="off"
                    placeholder="teammate@example.com"
                    :class="[
                        cmp.input('w-full'),
                        emailTouched && email.trim().length > 0 && !validEmail(email.trim().toLowerCase()) ? 'ui-field-input-error' : '',
                    ]"
                    @blur="emailTouched = true"
                />
                <Button type="submit" label="Invite" :loading="busy" :disabled="busy || !validEmail(email.trim().toLowerCase())">
                    <template #icon><Icon name="send" /></template>
                </Button>
            </div>
            <span v-if="emailTouched && email.trim().length > 0 && !validEmail(email.trim().toLowerCase())" class="ui-field-error">
                <Icon name="exclamation-triangle" class="text-2xs" />
                Enter a valid email address.
            </span>
        </form>
    </Dialog>
</template>
