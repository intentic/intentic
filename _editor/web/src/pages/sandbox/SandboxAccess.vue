<script setup lang="ts">
import type { InviteRecord } from "@intentic-app/api-contract";
import { Avatar, cmp, RowGroup } from "@intentic/ui";
import Button from "primevue/button";
import { computed, onMounted, ref } from "vue";
import { sandboxJson } from "../../composables/sandbox/sandboxClient";
import { jsonBody } from "../../composables/sandbox/jsonBody";
import { apiClient, isPaymentRequired } from "../../composables/useApi";
import { errorMessage } from "../../composables/useAsyncAction";
import { useAuth } from "../../composables/useAuth";
import { useSandbox } from "../../composables/sandbox/useSandbox";
import { identityHue } from "../../composables/identityHue";
import { presenceActivity, presenceOthers } from "../../composables/usePresence";

/* The Sandbox hub's "Access" tab. Owner-only invites for the ACTIVE sandbox: inviting is two writes — the
 * daemon's ENFORCED /members list (pushed first from the owner's browser, since the server can't reach the
 * daemon) then the platform invite record + email. sandboxJson throws on any non-2xx, so a grant the enforcer
 * never got is never recorded (fail closed). Members see a read-only view. "Here now" (live presence) shows for
 * everyone. Inviting is plan-gated — a PAYMENT_REQUIRED opens the upgrade dialog. */

const { user, upgradeOpen } = useAuth();
const sandbox = useSandbox();

const isOwner = computed(() => sandbox.active.value?.role === `owner`);

const members = ref<InviteRecord[]>([]);
const email = ref(``);
const busy = ref(false);
const error = ref<string>();
const emailTouched = ref(false);

const validEmail = (value: string): boolean => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value);

// Inviting is plan-gated: a PAYMENT_REQUIRED anywhere opens the upgrade dialog; anything else shows inline.
const gateOrError = (err: unknown, fallback: string): void => {
    if (isPaymentRequired(err)) {
        upgradeOpen.value = true;
        return;
    }
    error.value = errorMessage(err, fallback);
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

// The invite list is owner-only (the API 403s a member) — only load it when the viewer owns this sandbox.
onMounted(() => {
    if (isOwner.value) {
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
        await sandboxJson<{ emails: string[] }>(`/members`, jsonBody(`POST`, { email: value }));
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

/* "Sign out everywhere". A sandbox session is a 30-day signed claim living in each browser's localStorage, so
 * a device that walked off keeps working until it expires — and there is no per-device list to revoke from,
 * because nothing is stored per session. Re-keying the daemon's signer is the revocation, and it takes every
 * browser with it including this one: the next call 401s and re-establishes from the Google credential this tab
 * already holds, so the owner sees nothing. Members are signed out too and come back only if still on the list. */
const revokingSessions = ref(false);
const sessionsRevoked = ref(false);

const revokeSessions = async (): Promise<void> => {
    if (revokingSessions.value) {
        return;
    }
    revokingSessions.value = true;
    error.value = undefined;
    sessionsRevoked.value = false;
    try {
        await sandboxJson<{ ok: boolean }>(`/system/sessions/revoke`, { method: `POST` });
        sessionsRevoked.value = true;
    } catch (err) {
        error.value = errorMessage(err, `Couldn't sign other browsers out — is the sandbox online?`);
    } finally {
        revokingSessions.value = false;
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
        await sandboxJson<{ emails: string[] }>(`/members`, jsonBody(`DELETE`, { email: target }));
        members.value = (await apiClient.invite.revoke({ sandboxId: id, email: target })).members;
    } catch (err) {
        gateOrError(err, `Couldn't revoke access — is the sandbox online?`);
    } finally {
        busy.value = false;
    }
};
</script>

<template>
    <div class="flex flex-col gap-6">
        <!-- Members + invites (owner) / read-only note (member). -->
        <RowGroup label="Access">
            <template v-if="isOwner">
                <div class="flex items-center gap-2.5 px-4 py-3">
                    <Icon name="user" class="text-muted" />
                    <span class="min-w-0 flex-1 truncate text-sm text-content">{{ user?.email }}</span>
                    <span class="shrink-0 rounded-full bg-primary-600/15 px-1.5 py-0.5 text-2xs font-semibold text-link">Owner</span>
                </div>
                <div v-for="member in members" :key="member.email" class="flex items-center gap-2.5 px-4 py-3">
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

                <!-- Invite affordance as the group's footer row (mirrors the Secrets "add" pattern). -->
                <div class="flex flex-col gap-2 px-4 py-3">
                    <p class="text-xs text-muted">
                        People you invite get an email to open
                        <span class="font-medium text-content">{{ sandbox.active.value?.name }}</span> and sign in with their own Google account.
                    </p>
                    <div v-if="error" :class="cmp.alertDanger()">{{ error }}</div>
                    <form class="flex flex-col gap-2" @submit.prevent="invite">
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
                </div>
            </template>

            <template v-else>
                <div class="flex items-center gap-2.5 px-4 py-3">
                    <Icon name="user" class="text-muted" />
                    <span class="min-w-0 flex-1 truncate text-sm text-content">{{ user?.email }}</span>
                    <span class="shrink-0 rounded-full bg-content/10 px-1.5 py-0.5 text-2xs font-semibold text-subtle">You</span>
                </div>
                <div class="px-4 py-3 text-xs text-muted">Only the sandbox owner can invite or remove people.</div>
            </template>
        </RowGroup>

        <!-- The credential kill switch. Owner-only, and separate from the member list above on purpose: this
             answers "is anything still holding a way in", not "who is allowed in". -->
        <RowGroup v-if="isOwner" label="Signed-in browsers">
            <div class="flex flex-col gap-2 px-4 py-3">
                <p class="text-xs text-muted">
                    Browsers stay signed in to this sandbox for 30 days. Sign them all out if a device was lost or shared — everyone still on the
                    access list simply signs in again with Google.
                </p>
                <p v-if="sessionsRevoked" class="flex items-center gap-1.5 text-xs font-semibold text-success">
                    <Icon name="check-circle" /> Every browser has been signed out of this sandbox.
                </p>
                <div>
                    <Button
                        label="Sign out all browsers"
                        severity="danger"
                        :outlined="true"
                        :loading="revokingSessions"
                        :disabled="revokingSessions"
                        @click="revokeSessions"
                    >
                        <template #icon><Icon name="sign-out" /></template>
                    </Button>
                </div>
            </div>
        </RowGroup>

        <!-- Live presence: who else is connected right now (everyone sees this). -->
        <RowGroup label="Here now">
            <div v-if="presenceOthers.length === 0" class="px-4 py-6 text-center text-xs text-muted">No one else is connected right now.</div>
            <template v-else>
                <div
                    v-for="member in presenceOthers"
                    :key="member.email"
                    class="flex items-center gap-2.5 px-4 py-3"
                    :class="member.idle ? 'opacity-60' : ''"
                >
                    <Avatar :size="32" :name="member.name ?? member.email" :src="member.picture" :hue="identityHue(member.email)" />
                    <div class="min-w-0 flex-1">
                        <div class="truncate text-sm font-medium text-content">{{ member.name ?? member.email }}</div>
                        <div class="truncate text-xs text-muted">{{ presenceActivity(member) }}</div>
                    </div>
                    <span v-if="member.idle" class="shrink-0 text-2xs text-subtle">idle</span>
                </div>
            </template>
        </RowGroup>
    </div>
</template>
