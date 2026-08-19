<script setup lang="ts">
import type { InviteDelivery, InviteRecord } from "@intentic-app/api-contract";
import type { GrantedRole, MemberRole } from "@intentic/sandbox-contract";
import { Avatar, clipboardOf, ui, Notice, type NoticeModel, NoticeStack, RowGroup, SegmentedControl, SkeletonRows } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import Button from "primevue/button";
import Select from "primevue/select";
import { computed, onMounted, ref } from "vue";
import { sandboxJson } from "../../composables/sandbox/sandboxClient";
import { jsonBody } from "../../composables/sandbox/jsonBody";
import { apiClient } from "../../composables/useApi";
import { useAuth } from "../../composables/useAuth";
import { useSandbox } from "../../composables/sandbox/useSandbox";
import { useSandboxOutline } from "../../composables/sandbox/useSandboxOutline";
import { identityHue } from "../../composables/identityHue";
import { presenceActivity, presenceOthers } from "../../composables/usePresence";

/* The Sandbox hub's "Access" tab. Owner-only invites for the ACTIVE sandbox: inviting is two writes — the
 * daemon's ENFORCED /members list (pushed first from the owner's browser, since the server can't reach the
 * daemon) then the platform invite record + email. sandboxJson throws on any non-2xx, so a grant the enforcer
 * never got is never recorded (fail closed). Members see a read-only view. "Here now" (live presence) shows for
 * everyone.
 *
 * TWO WRITES, TWO SENTENCES. They used to share one catch, so a platform-side failure read as "is the sandbox
 * online?" — asked about a sandbox that had just answered the write immediately before. Each half now says what
 * it is: the daemon is the one that can be offline, and the platform is the one that records the invite.
 *
 * And the mail is the THIRD thing, which is not a failure at all: by the time it is attempted the invitee is
 * granted on the daemon and recorded here, so a send that was declined (no mail credentials, or a platform
 * whose own address only resolves on this machine) or refused comes back as an outcome plus the link. The owner
 * becomes the courier — which is the only thing that works at all when running the platform locally.
 *
 * EVERY GRANT IS A ROLE. The invite form asks which tier it is handing out (collaborator preselected — safe to
 * give without thinking, useful enough that nobody feels locked out), and each roster row re-grades in place
 * through the same two-write, daemon-first order as the grant itself. The words are deliberately "can…"
 * sentences: the tier model is taught here or nowhere. */

const { user } = useAuth();
const sandbox = useSandbox();

const isOwner = computed(() => sandbox.active.value?.role === `owner`);

const members = ref<InviteRecord[]>([]);
const email = ref(``);

// The three tiers an invite can grant, in the order they nest, each with the sentence that IS the model.
const ROLE_OPTIONS: readonly { label: string; value: GrantedRole }[] = [
    { label: `Viewer`, value: `viewer` },
    { label: `Collaborator`, value: `collaborator` },
    { label: `Maintainer`, value: `maintainer` },
];
const ROLE_BLURB: Record<GrantedRole, string> = {
    viewer: `Can watch everything — agents, chats, files. Can't change anything.`,
    collaborator: `Can drive agents and review work. Landing and publishing become requests.`,
    maintainer: `Can ship and operate: land work, approve drafts, use the terminal.`,
};
const roleLabel = (role: MemberRole): string => role.charAt(0).toUpperCase() + role.slice(1);
const inviteRole = ref<GrantedRole>(`collaborator`);
const busy = ref(false);
// The one thing this tab has to say right now: a failure, or an invite whose link the owner must carry.
const notice = ref<NoticeModel>();

// The accept link the owner has to carry, whenever the mail didn't. Beside `notice` rather than inside it: a
// link is markup (it wraps, it is selected, it is never shortened), which the plain-string model can't hold.
const handover = ref<string>();

// Both together, always: a link with no sentence over it is noise, and a sentence about a link that is no
// longer shown is worse. Every action starts here.
const clearNotice = (): void => {
    notice.value = undefined;
    handover.value = undefined;
};

const emailTouched = ref(false);

const validEmail = (value: string): boolean => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value);

const badge = (status: InviteRecord["status"]): { label: string; class: string } => {
    if (status === `accepted`) {
        return { label: `Member`, class: `bg-primary-600/15 text-link` };
    }
    if (status === `expired`) {
        return { label: `Expired`, class: `bg-danger/10 text-danger` };
    }
    return { label: `Pending`, class: `bg-overlay text-muted` };
};

/* THE FIRST READ ONLY, and only the one on mount. Every other call here follows a write whose response IS the
 * new roster, so the list is never blank across them — outlining a re-grade would flash a placeholder over rows
 * that are already correct. `listing` starts true because the fetch is armed in onMounted: starting it false
 * would paint one frame of "no members" first, which is the whole thing this is here to stop. */
const listing = ref(true);

const load = async (): Promise<void> => {
    const id = sandbox.activeSandboxId.value;
    if (id === undefined) {
        listing.value = false;
        return;
    }
    clearNotice();
    try {
        members.value = (await apiClient.invite.list({ sandboxId: id })).members;
    } catch (err) {
        notice.value = noticeFrom(err, `Couldn't load the access list.`);
    } finally {
        listing.value = false;
    }
};

/* An owner's roster is a network read and looked blank until it landed — a page that opens claiming you have
 * invited nobody, on the tab whose subject is who else is in here. The rows below stand in for it meanwhile. */
const outline = useSandboxOutline(listing);

// The invite list is owner-only (the API 403s a member) — only load it when the viewer owns this sandbox.
onMounted(() => {
    if (isOwner.value) {
        void load();
        return;
    }
    // A member never fetches, so nothing is pending for them: leaving this armed would outline a list that is
    // never coming.
    listing.value = false;
});

/* What to say when the link did not travel by mail. Not an error — the person IS invited, on the daemon and in
 * the record — so the sentence is about the delivery, `detail` carries what the mail provider actually said,
 * and the way out is the link itself: shown below (selectable, and the one thing here that must never be
 * truncated) with a button that copies it. `sent` needs nothing said: the mail is the message. */
const DELIVERY_NOTE: Record<Exclude<InviteDelivery, "sent">, string> = {
    unconfigured: `Invited. Email isn't set up on this platform, so send them this link yourself:`,
    "local-link": `Invited. This platform only answers on your own machine, so an emailed link would go nowhere. Send them this one yourself:`,
    refused: `Invited. The email was refused, so send them this link yourself:`,
};

const showDelivery = (result: { link: string; delivery: InviteDelivery; reason?: string }): void => {
    handover.value = result.delivery === `sent` ? undefined : result.link;
    notice.value =
        result.delivery === `sent`
            ? undefined
            : {
                  tone: `warning`,
                  title: DELIVERY_NOTE[result.delivery],
                  detail: result.reason,
                  action: {
                      label: `Copy link`,
                      /* Through the clicked button's own window: this panel can be popped out, and the
                       * module-global clipboard there belongs to a document that isn't focused (clipboardOf).
                       *
                       * Best-effort on purpose. A platform served without TLS has no clipboard API at all, and
                       * the copy is a convenience over a link that is already on screen to select — so a refusal
                       * here must not become an error about an invite that succeeded. */
                      run: () => void Promise.resolve(clipboardOf(document.activeElement)?.writeText(result.link)).catch(() => undefined),
                  },
              };
};

const invite = async (): Promise<void> => {
    const id = sandbox.activeSandboxId.value;
    const value = email.value.trim().toLowerCase();
    if (id === undefined || busy.value || !validEmail(value)) {
        return;
    }
    busy.value = true;
    clearNotice();
    try {
        // Push to the daemon first (owner-gated, enforced), then record the invite + send the email. sandboxJson
        // throws on a non-2xx daemon reply (403/401/offline), so an unenforced grant is never recorded as sent —
        // and its own catch keeps that failure from being reported as anything else.
        try {
            await sandboxJson<{ members: { email: string; role: GrantedRole }[] }>(
                `/members`,
                jsonBody(`POST`, { email: value, role: inviteRole.value }),
            );
        } catch (err) {
            notice.value = noticeFrom(err, `Couldn't grant access on the sandbox — is it online?`);
            return;
        }
        const result = await apiClient.invite.create({ sandboxId: id, email: value, role: inviteRole.value });
        members.value = result.members;
        email.value = ``;
        emailTouched.value = false;
        showDelivery(result);
    } catch (err) {
        // The sandbox took the grant and the platform then refused to record it: resync so the roster shows
        // whatever it actually holds rather than what this call assumed.
        void load();
        notice.value = noticeFrom(err, `The sandbox granted access, but recording the invite failed.`);
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
    clearNotice();
    try {
        const result = await apiClient.invite.resend({ sandboxId: id, email: target });
        members.value = result.members;
        showDelivery(result);
    } catch (err) {
        notice.value = noticeFrom(err, `Couldn't resend the invite.`);
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
    clearNotice();
    sessionsRevoked.value = false;
    try {
        await sandboxJson<{ ok: boolean }>(`/system/sessions/revoke`, { method: `POST` });
        sessionsRevoked.value = true;
    } catch (err) {
        notice.value = noticeFrom(err, `Couldn't sign other browsers out — is the sandbox online?`);
    } finally {
        revokingSessions.value = false;
    }
};

// Re-grade a member: the same two-write, daemon-first order as the grant, because it IS one — the daemon's
// list is what a role change must reach to mean anything, and it applies on the member's next request.
const setRole = async (target: string, role: GrantedRole): Promise<void> => {
    const id = sandbox.activeSandboxId.value;
    if (id === undefined || busy.value) {
        return;
    }
    busy.value = true;
    clearNotice();
    try {
        // Same split as the grant: only the first of the two writes can be a sandbox that isn't answering.
        try {
            await sandboxJson<{ members: { email: string; role: GrantedRole }[] }>(`/members`, jsonBody(`POST`, { email: target, role }));
        } catch (err) {
            notice.value = noticeFrom(err, `Couldn't change the role on the sandbox — is it online?`);
            return;
        }
        members.value = (await apiClient.invite.setRole({ sandboxId: id, email: target, role })).members;
    } catch (err) {
        void load();
        notice.value = noticeFrom(err, `The sandbox took the new role, but recording it failed.`);
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
    clearNotice();
    try {
        // sandboxJson throws on a non-2xx daemon reply, so revoke reaches the enforcer before the platform row is
        // dropped — a daemon that rejects/is offline surfaces an error instead of a member who still has access.
        try {
            await sandboxJson<{ members: { email: string; role: GrantedRole }[] }>(`/members`, jsonBody(`DELETE`, { email: target }));
        } catch (err) {
            notice.value = noticeFrom(err, `Couldn't take access away on the sandbox — is it online?`);
            return;
        }
        members.value = (await apiClient.invite.revoke({ sandboxId: id, email: target })).members;
    } catch (err) {
        void load();
        notice.value = noticeFrom(err, `Access is gone on the sandbox, but clearing the record failed.`);
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
                <div v-if="listing" role="status" aria-busy="true">
                    <template v-if="outline">
                        <span class="sr-only">Reading who has access…</span>
                        <SkeletonRows :rows="2" control />
                    </template>
                </div>
                <div v-for="member in members" :key="member.email" class="flex items-center gap-2.5 px-4 py-3">
                    <Icon name="user" class="text-muted" />
                    <span class="min-w-0 flex-1 truncate text-sm text-content">{{ member.email }}</span>
                    <!-- The row's role, changeable in place: a re-grade is routine (that is the whole point of
                         tiers), so it must not cost a revoke + re-invite. -->
                    <Select
                        :model-value="member.role"
                        :options="[...ROLE_OPTIONS]"
                        option-label="label"
                        option-value="value"
                        size="small"
                        class="shrink-0 text-xs"
                        :disabled="busy"
                        :aria-label="`Role for ${member.email}`"
                        @update:model-value="(role: GrantedRole) => setRole(member.email, role)"
                    />
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
                    <!-- The link goes in the slot, not in the model: it must wrap rather than run out of the
                         box, and it is the one thing on this card a person copies by hand. -->
                    <Notice v-if="notice" :of="notice">
                        <span v-if="handover" class="mt-1 block break-all font-medium">{{ handover }}</span>
                    </Notice>
                    <form class="flex flex-col gap-2" @submit.prevent="invite">
                        <!-- The tier goes with the address: an invite IS a role decision, and the sentence
                             under the picker is where the model is taught. Collaborator preselected. -->
                        <SegmentedControl v-model="inviteRole" :options="[...ROLE_OPTIONS]" />
                        <span class="text-xs text-muted">{{ ROLE_BLURB[inviteRole] }}</span>
                        <div class="flex items-center gap-2">
                            <input
                                v-model="email"
                                type="email"
                                autocomplete="off"
                                placeholder="teammate@example.com"
                                :class="[
                                    ui.input('w-full'),
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
                    <span class="shrink-0 rounded-full bg-primary-600/15 px-1.5 py-0.5 text-2xs font-semibold text-link">{{
                        roleLabel(sandbox.active.value?.role ?? `viewer`)
                    }}</span>
                    <span class="shrink-0 rounded-full bg-content/10 px-1.5 py-0.5 text-2xs font-semibold text-subtle">You</span>
                </div>
                <div class="px-4 py-3 text-xs text-muted">Only the sandbox owner can invite people or change roles.</div>
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
                    <!-- The role rides presence: who may do what is a fact every member gets to see. -->
                    <span class="shrink-0 rounded-full bg-content/10 px-1.5 py-0.5 text-2xs font-medium text-subtle">{{
                        roleLabel(member.role)
                    }}</span>
                    <span v-if="member.idle" class="shrink-0 text-2xs text-subtle">idle</span>
                </div>
            </template>
        </RowGroup>
    </div>
</template>
