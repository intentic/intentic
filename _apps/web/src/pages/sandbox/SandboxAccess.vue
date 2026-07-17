<script setup lang="ts">
import type { InviteRecord } from "@intentic-app/api-contract";
import { Card, cmp } from "@intentic-app/ui";
import Button from "primevue/button";
import { computed, onMounted, ref } from "vue";
import { sandboxJson } from "../../composables/sandbox/sandboxClient";
import { apiClient, isPaymentRequired } from "../../composables/useApi";
import { useAuth } from "../../composables/useAuth";
import { useSandbox } from "../../composables/sandbox/useSandbox";
import { presenceActivity, presenceHue, presenceInitials, presenceOthers } from "../../composables/usePresence";

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
    <div class="flex flex-col gap-2.5">
        <!-- Members + invites (owner) / read-only note (member). -->
        <Card class="flex flex-col gap-3">
            <div class="flex items-center gap-2.5">
                <Icon name="users" class="text-lg text-muted" />
                <div>
                    <h2 class="font-semibold leading-tight">Access</h2>
                    <p class="text-xs text-muted">Who can reach this sandbox and everything inside it.</p>
                </div>
            </div>

            <template v-if="isOwner">
                <p class="text-sm text-muted">
                    People you invite get an email with a link to open
                    <span class="font-medium text-content">{{ sandbox.active.value?.name }}</span> — they accept and sign in with their own Google
                    account.
                </p>

                <div v-if="error" :class="cmp.alertDanger()">{{ error }}</div>

                <div class="flex flex-col gap-2">
                    <div class="flex items-center gap-2.5 rounded-lg border border-line bg-card px-3 py-2">
                        <Icon name="user" class="text-muted" />
                        <span class="min-w-0 flex-1 truncate text-sm text-content">{{ user?.email }}</span>
                        <span class="shrink-0 rounded-full bg-primary-600/15 px-1.5 py-0.5 text-2xs font-semibold text-link">Owner</span>
                    </div>
                    <div
                        v-for="member in members"
                        :key="member.email"
                        class="flex items-center gap-2.5 rounded-lg border border-line bg-card px-3 py-2"
                    >
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
            </template>

            <template v-else>
                <div class="flex items-center gap-2.5 rounded-lg border border-line bg-card px-3 py-2">
                    <Icon name="user" class="text-muted" />
                    <span class="min-w-0 flex-1 truncate text-sm text-content">{{ user?.email }}</span>
                    <span class="shrink-0 rounded-full bg-content/10 px-1.5 py-0.5 text-2xs font-semibold text-subtle">You</span>
                </div>
                <p class="text-xs text-muted">Only the sandbox owner can invite or remove people.</p>
            </template>
        </Card>

        <!-- Live presence: who else is connected right now (everyone sees this). -->
        <Card class="flex flex-col gap-3">
            <div class="flex items-center gap-2.5">
                <Icon name="wave-pulse" class="text-lg text-muted" />
                <div>
                    <h2 class="font-semibold leading-tight">Here now</h2>
                    <p class="text-xs text-muted">Other members connected to this sandbox right now.</p>
                </div>
            </div>
            <div v-if="presenceOthers.length === 0" :class="cmp.emptyState('py-6')">No one else is connected right now.</div>
            <div v-else class="flex flex-col gap-2">
                <div
                    v-for="member in presenceOthers"
                    :key="member.email"
                    class="flex items-center gap-2.5 rounded-lg border border-line bg-canvas px-3 py-2"
                    :class="member.idle ? 'opacity-60' : ''"
                >
                    <span
                        class="flex h-8 w-8 shrink-0 items-center justify-center overflow-hidden rounded-full text-2xs font-semibold"
                        :style="{
                            backgroundColor: `hsl(${presenceHue(member.email)} 70% 45% / 0.15)`,
                            color: `hsl(${presenceHue(member.email)} 70% 45%)`,
                        }"
                    >
                        <img v-if="member.picture" :src="member.picture" alt="" referrerpolicy="no-referrer" class="h-full w-full object-cover" />
                        <span v-else>{{ presenceInitials(member) }}</span>
                    </span>
                    <div class="min-w-0">
                        <div class="truncate text-sm font-medium text-content">{{ member.name ?? member.email }}</div>
                        <div class="truncate text-xs text-muted">{{ presenceActivity(member) }}</div>
                    </div>
                    <span v-if="member.idle" class="ml-auto shrink-0 text-2xs text-subtle">idle</span>
                </div>
            </div>
        </Card>
    </div>
</template>
