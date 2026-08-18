<script setup lang="ts">
import type { InviteRecord } from "@intentic-app/api-contract";
import type { GrantedRole, MemberRole } from "@intentic/sandbox-contract";
import { Avatar, ui, Notice, type NoticeModel, NoticeStack, RowGroup, SegmentedControl, SkeletonRows } from "@intentic/ui";
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
const error = ref<NoticeModel>();
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
    error.value = undefined;
    try {
        members.value = (await apiClient.invite.list({ sandboxId: id })).members;
    } catch (err) {
        error.value = noticeFrom(err, `Couldn't load the access list.`);
    } finally {
        listing.value = false;
    }
};

/* An owner's roster is a network read and looked blank until it landed — a page that opens claiming you have
 * invited nobody, on the tab whose subject is who else is in here. The rows below stand in for it meanwhile. */
const outline = useSandboxOutline(listing);

/* JOIN LINKS — the second way to let somebody in, and the one that needs nothing from the platform: the box
 * mints a secret, the owner sends it however they like, and whoever opens it signs in with Google and lands
 * on the very list above. Everything here is owner-gated by the daemon (auth/join-links.ts); this screen is
 * where an owner reads what is outstanding and takes one back.
 *
 * The link is shown ONCE. Only its digest is stored, so a link nobody copied is a link nobody can recover —
 * which is the property that makes the list safe to leave lying open on a screen. */
interface JoinLinkSummary {
    readonly id: string;
    readonly label: string;
    readonly role: GrantedRole;
    readonly createdAt: number;
    readonly expiresAt?: number;
    readonly maxUses?: number;
    readonly redeemedBy: readonly string[];
}
const joinLinks = ref<JoinLinkSummary[]>([]);
const linkLabel = ref(``);
const linkRole = ref<GrantedRole>(`collaborator`);
// Bounded by default in both dimensions: a link is a credential that lives in somebody's chat history, so the
// safe shape has to be the one an owner gets by not thinking about it.
const linkDays = ref(7);
const linkSeats = ref(1);
const linkBusy = ref(false);
const linkError = ref<NoticeModel>();
const mintedLink = ref<string>();
const copied = ref(false);

const EXPIRY_OPTIONS = [
    { label: `1 day`, value: 1 },
    { label: `7 days`, value: 7 },
    { label: `30 days`, value: 30 },
    { label: `No expiry`, value: 0 },
] as const;
const SEAT_OPTIONS = [
    { label: `1 person`, value: 1 },
    { label: `5 people`, value: 5 },
    { label: `Anyone with the link`, value: 0 },
] as const;

const loadJoinLinks = async (): Promise<void> => {
    joinLinks.value = (await sandboxJson<{ links: JoinLinkSummary[] }>(`/join-links`)).links;
};

/* The address a guest opens. Deliberately built from `daemonUrl` — the sandbox's PUBLIC identity — and never
 * from whatever this browser happens to be reaching the box through: the owner may be on the loopback
 * shortcut, which is an address that exists on their machine alone. */
const linkFor = (secret: string): string | undefined => {
    // Null while a sandbox has never announced an address — a box nobody could reach with a link anyway.
    const daemonUrl = sandbox.active.value?.daemonUrl ?? undefined;
    return daemonUrl === undefined || daemonUrl === ``
        ? undefined
        : `${globalThis.location.origin}/join#s=${encodeURIComponent(daemonUrl)}&k=${encodeURIComponent(secret)}`;
};

const mintLink = async (): Promise<void> => {
    if (linkBusy.value) {
        return;
    }
    linkBusy.value = true;
    linkError.value = undefined;
    copied.value = false;
    try {
        const minted = await sandboxJson<{ secret: string; links: JoinLinkSummary[] }>(
            `/join-links`,
            jsonBody(`POST`, {
                label: linkLabel.value.trim() === `` ? `Guest link` : linkLabel.value.trim(),
                role: linkRole.value,
                ...(linkDays.value > 0 ? { expiresInDays: linkDays.value } : {}),
                ...(linkSeats.value > 0 ? { maxUses: linkSeats.value } : {}),
            }),
        );
        joinLinks.value = minted.links;
        mintedLink.value = linkFor(minted.secret);
        linkLabel.value = ``;
        if (mintedLink.value === undefined) {
            linkError.value = noticeFrom(undefined, `This sandbox has no public address yet, so a link can't be built for it.`);
        }
    } catch (err) {
        linkError.value = noticeFrom(err, `Couldn't create the link — is the sandbox online?`);
    } finally {
        linkBusy.value = false;
    }
};

const revokeLink = async (id: string): Promise<void> => {
    if (linkBusy.value) {
        return;
    }
    linkBusy.value = true;
    linkError.value = undefined;
    try {
        joinLinks.value = (await sandboxJson<{ links: JoinLinkSummary[] }>(`/join-links`, jsonBody(`DELETE`, { id }))).links;
    } catch (err) {
        linkError.value = noticeFrom(err, `Couldn't revoke the link — is the sandbox online?`);
    } finally {
        linkBusy.value = false;
    }
};

const copyLink = async (): Promise<void> => {
    const value = mintedLink.value;
    if (value === undefined) {
        return;
    }
    await navigator.clipboard.writeText(value);
    copied.value = true;
};

// The invite list is owner-only (the API 403s a member) — only load it when the viewer owns this sandbox.
onMounted(() => {
    if (isOwner.value) {
        void load();
        // Same gate, and equally owner-only at the daemon — but its own failure: a box that is offline must
        // not make the roster above look broken.
        void loadJoinLinks().catch(() => {});
        return;
    }
    // A member never fetches, so nothing is pending for them: leaving this armed would outline a list that is
    // never coming.
    listing.value = false;
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
        await sandboxJson<{ members: { email: string; role: GrantedRole }[] }>(
            `/members`,
            jsonBody(`POST`, { email: value, role: inviteRole.value }),
        );
        members.value = (await apiClient.invite.create({ sandboxId: id, email: value, role: inviteRole.value })).members;
        email.value = ``;
        emailTouched.value = false;
    } catch (err) {
        // The daemon push (or an offline sandbox) can fail before the invite is recorded; resync so a pending
        // invite created just before an email failure still shows with a Resend action.
        void load();
        error.value = noticeFrom(err, `Couldn't send the invite — is the sandbox online?`);
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
        error.value = noticeFrom(err, `Couldn't resend the invite.`);
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
        error.value = noticeFrom(err, `Couldn't sign other browsers out — is the sandbox online?`);
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
    error.value = undefined;
    try {
        await sandboxJson<{ members: { email: string; role: GrantedRole }[] }>(`/members`, jsonBody(`POST`, { email: target, role }));
        members.value = (await apiClient.invite.setRole({ sandboxId: id, email: target, role })).members;
    } catch (err) {
        void load();
        error.value = noticeFrom(err, `Couldn't change the role — is the sandbox online?`);
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
        await sandboxJson<{ members: { email: string; role: GrantedRole }[] }>(`/members`, jsonBody(`DELETE`, { email: target }));
        members.value = (await apiClient.invite.revoke({ sandboxId: id, email: target })).members;
    } catch (err) {
        error.value = noticeFrom(err, `Couldn't revoke access — is the sandbox online?`);
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
                    <Notice v-if="error" :of="error" />
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

        <!-- Join links: access without an invite, an email, or an account on the platform. Its own group
             because it answers a different question from the roster above — "how can somebody get in", rather
             than "who is in". -->
        <RowGroup v-if="isOwner" label="Join links">
            <div v-for="entry in joinLinks" :key="entry.id" class="flex items-center gap-2.5 px-4 py-3">
                <Icon name="link" class="text-muted" />
                <span class="min-w-0 flex-1 truncate text-sm text-content">{{ entry.label }}</span>
                <span class="shrink-0 text-2xs text-subtle">
                    {{ entry.redeemedBy.length }}<template v-if="entry.maxUses !== undefined">/{{ entry.maxUses }}</template> joined
                </span>
                <span class="shrink-0 rounded-full bg-primary-600/15 px-1.5 py-0.5 text-2xs font-semibold text-link">{{
                    roleLabel(entry.role)
                }}</span>
                <Button
                    size="small"
                    severity="danger"
                    :text="true"
                    :rounded="true"
                    :disabled="linkBusy"
                    aria-label="Revoke link"
                    @click="revokeLink(entry.id)"
                >
                    <template #icon><Icon name="times" /></template>
                </Button>
            </div>

            <div class="flex flex-col gap-2 px-4 py-3">
                <p class="text-xs text-muted">
                    A link lets someone open <span class="font-medium text-content">{{ sandbox.active.value?.name }}</span> by signing in with Google
                    — no invite and no intentic account. Revoking a link stops new people using it; anyone already in stays on the list above until
                    you remove them there.
                </p>
                <Notice v-if="linkError" :of="linkError" />

                <!-- Shown once, and said so: only a fingerprint of the link is kept, so a link nobody copied
                     cannot be recovered — it has to be made again. -->
                <div v-if="mintedLink" class="flex flex-col gap-2 rounded-lg border border-line bg-overlay p-3">
                    <span class="text-xs font-semibold text-content">Copy it now — it isn't shown again.</span>
                    <div class="flex items-center gap-2">
                        <input :value="mintedLink" readonly :class="ui.input('w-full font-mono text-xs')" aria-label="Join link" />
                        <Button :label="copied ? 'Copied' : 'Copy'" size="small" severity="secondary" @click="copyLink" />
                    </div>
                </div>

                <form class="flex flex-col gap-2" @submit.prevent="mintLink">
                    <SegmentedControl v-model="linkRole" :options="[...ROLE_OPTIONS]" />
                    <span class="text-xs text-muted">{{ ROLE_BLURB[linkRole] }}</span>
                    <div class="flex items-center gap-2">
                        <input v-model="linkLabel" type="text" autocomplete="off" placeholder="What is this link for?" :class="ui.input('w-full')" />
                        <Select
                            v-model="linkDays"
                            :options="[...EXPIRY_OPTIONS]"
                            option-label="label"
                            option-value="value"
                            size="small"
                            class="shrink-0 text-xs"
                            aria-label="Link expiry"
                        />
                        <Select
                            v-model="linkSeats"
                            :options="[...SEAT_OPTIONS]"
                            option-label="label"
                            option-value="value"
                            size="small"
                            class="shrink-0 text-xs"
                            aria-label="How many people"
                        />
                        <Button type="submit" label="Create link" :loading="linkBusy" :disabled="linkBusy">
                            <template #icon><Icon name="link" /></template>
                        </Button>
                    </div>
                </form>
            </div>
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
