<script setup lang="ts">
import type { InviteDelivery, InviteRecord } from "@intentic-app/api-contract";
import type { GrantedRole, MemberRole } from "@intentic/sandbox-contract";
import {
    Avatar,
    Button,
    clipboardOf,
    Notice,
    type NoticeModel,
    Picker,
    type PickerOption,
    Row,
    RowGroup,
    RowNote,
    SkeletonRows,
    ui,
} from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { formatDate } from "@intentic/ui/format";
import { computed, onMounted, ref } from "vue";
import { sandboxJson } from "../../composables/sandbox/sandboxClient";
import { jsonBody } from "../../composables/sandbox/jsonBody";
import { apiClient } from "../../composables/useApi";
import { useAuth } from "../../composables/useAuth";
import { useSandbox } from "../../composables/sandbox/useSandbox";
import { useSandboxSession } from "../../composables/sandbox/sandboxSession";
import { useSandboxOutline } from "../../composables/sandbox/useSandboxOutline";
import { identityHue } from "../../composables/identityHue";
import { presenceActivity, presenceOthers } from "../../composables/usePresence";

/* The Sandbox hub's "Access" tab. Owner-only invites for the ACTIVE sandbox: inviting is two writes, the
 * daemon's ENFORCED /members list (pushed first from the owner's browser, since the server can't reach the
 * daemon) then the platform invite record + email. sandboxJson throws on any non-2xx, so a grant the enforcer
 * never got is never recorded (fail closed). Members see a read-only view. "Here now" (live presence) shows for
 * everyone.
 *
 * TWO WRITES, TWO SENTENCES. They used to share one catch, so a platform-side failure read as "is the sandbox
 * online?": asked about a sandbox that had just answered the write immediately before. Each half now says what
 * it is: the daemon is the one that can be offline, and the platform is the one that records the invite.
 *
 * And the mail is the THIRD thing, which is not a failure at all: by the time it is attempted the invitee is
 * granted on the daemon and recorded here, so a send that was declined (no mail credentials, or a platform
 * whose own address only resolves on this machine) or refused comes back as an outcome plus the link. The owner
 * becomes the courier, which is the only thing that works at all when running the platform locally.
 *
 * EVERY GRANT IS A ROLE. The invite form asks which tier it is handing out (collaborator preselected: safe to
 * give without thinking, useful enough that nobody feels locked out), and each roster row re-grades in place
 * through the same two-write, daemon-first order as the grant itself. The words are deliberately "can…"
 * sentences: the tier model is taught here or nowhere. */

const { user } = useAuth();
const sandbox = useSandbox();
const { sessionExpiresAt } = useSandboxSession();

const isOwner = computed(() => sandbox.active.value?.role === `owner`);

const members = ref<InviteRecord[]>([]);
const email = ref(``);

/* The three tiers an invite can grant, in the order they nest, each with the sentence that IS the model: ONE
 * list, read by both controls that hand a tier out. The invite form and each roster row both use <Picker>:
 * the form puts it beside the address and Invite button (role is a refinement on who you're inviting, not a
 * step before you know the address), with the sentence for the pending choice on the line below; a roster row
 * uses the ghost variant because the row already has an address, a status pill and buttons on it. */
const ROLE_OPTIONS: readonly PickerOption<GrantedRole>[] = [
    { label: `Viewer`, value: `viewer`, icon: `eye`, hint: `Can watch everything, agents, chats, files. Can't change anything.` },
    {
        label: `Collaborator`,
        value: `collaborator`,
        icon: `users`,
        hint: `Can drive agents and review work. Landing and publishing become requests.`,
    },
    {
        label: `Maintainer`,
        value: `maintainer`,
        icon: `wrench`,
        hint: `Can operate everything the owner can. The owner can revoke this access; the owner can't be revoked.`,
    },
];
const roleHint = (role: GrantedRole): string => ROLE_OPTIONS.find((option) => option.value === role)?.hint ?? ``;
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
 * new roster, so the list is never blank across them: outlining a re-grade would flash a placeholder over rows
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

/* An owner's roster is a network read and looked blank until it landed: a page that opens claiming you have
 * invited nobody, on the tab whose subject is who else is in here. The rows below stand in for it meanwhile. */
const outline = useSandboxOutline(listing);

// The invite list is owner-only (the API 403s a member): only load it when the viewer owns this sandbox.
onMounted(() => {
    if (isOwner.value) {
        void load();
        return;
    }
    // A member never fetches, so nothing is pending for them: leaving this armed would outline a list that is
    // never coming.
    listing.value = false;
});

/* What to say when the link did not travel by mail. Not an error: the person IS invited, on the daemon and in
 * the record, so the sentence is about the delivery, `detail` carries what the mail provider actually said,
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
                       * the copy is a convenience over a link that is already on screen to select, so a refusal
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
        // throws on a non-2xx daemon reply (403/401/offline), so an unenforced grant is never recorded as sent:
        // and its own catch keeps that failure from being reported as anything else.
        try {
            await sandboxJson<{ members: { email: string; role: GrantedRole }[] }>(
                `/members`,
                jsonBody(`POST`, { email: value, role: inviteRole.value }),
            );
        } catch (err) {
            notice.value = noticeFrom(err, `Couldn't grant access on the sandbox: is it online?`);
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

/* "Signed-in browsers": A SECTION THAT CANNOT HAVE A LIST IN IT, and used to pretend otherwise.
 *
 * A sandbox session is a 30-day signed claim living in each browser's localStorage. The daemon VERIFIES it
 * rather than looking it up, which is what keeps every request a local HMAC instead of a database read, so
 * nothing is stored per session and no device roster exists to render, here or on the daemon. The heading is a
 * plural noun, so it read as an empty list: one lone red button under a title promising devices, which invites
 * exactly the wrong conclusion ("nothing is signed in, so this button is pointless") about the one control
 * that answers a lost laptop. Hiding the group when empty would hide it forever, and hide the kill switch at
 * precisely the moment it is needed: the device you cannot enumerate is the device you are worried about.
 *
 * So the group says what is true instead. THIS browser is one signed-in browser and the app can speak for it
 * (identity, and the pass expiry it holds in localStorage); the absence of the others is a fact with a reason
 * worth one row; and the kill switch keeps its place, now with the consequence spelled out beside it rather
 * than left to be discovered. Re-keying the daemon's signer IS the revocation, and it takes every browser with
 * it including this one: the next call 401s and re-establishes from the Google credential this tab already
 * holds, so the owner sees nothing. Members are signed out too and come back only if still on the list. */
const revokingSessions = ref(false);
const sessionsRevoked = ref(false);
/* Armed before it fires, the same two-step inline confirm as account deletion. This signs out every person in
 * the sandbox, cannot be undone and cannot be aimed at one device, which is three reasons not to hang it on a
 * single click, and it sits one row under a roster whose own destructive buttons are per-member. */
const confirmingRevoke = ref(false);

// What this browser's own pass is worth, said as a date rather than a countdown: it slides forward whenever
// the session renews, so "expires Sep 24" is a fact about neglect ("if I stop opening this"), not a deadline.
const thisBrowser = computed<string>(() => {
    const who = user.value?.email ?? `You`;
    const expires = sessionExpiresAt.value;
    return expires === undefined ? `${who} · signed in` : `${who} · signed in until ${formatDate(expires)}, and renews whenever you use it`;
});

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
        confirmingRevoke.value = false;
    } catch (err) {
        notice.value = noticeFrom(err, `Couldn't sign other browsers out: is the sandbox online?`);
    } finally {
        revokingSessions.value = false;
    }
};

// Re-grade a member: the same two-write, daemon-first order as the grant, because it IS one, the daemon's
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
            notice.value = noticeFrom(err, `Couldn't change the role on the sandbox: is it online?`);
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
        // dropped: a daemon that rejects/is offline surfaces an error instead of a member who still has access.
        try {
            await sandboxJson<{ members: { email: string; role: GrantedRole }[] }>(`/members`, jsonBody(`DELETE`, { email: target }));
        } catch (err) {
            notice.value = noticeFrom(err, `Couldn't take access away on the sandbox: is it online?`);
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
        <!-- The rows below are <Row>s now rather than three hand-drawn shapes at px-4 py-3 on a surface whose
             own outline drew a different tier again. They take the group's, like every list in the app. -->
        <RowGroup label="Access">
            <template v-if="isOwner">
                <Row icon="user" :title="user?.email">
                    <template #meta>
                        <span class="rounded-full bg-primary-600/15 px-1.5 py-0.5 text-2xs font-semibold text-link">Owner</span>
                    </template>
                </Row>
                <div v-if="listing" role="status" aria-busy="true">
                    <template v-if="outline">
                        <span class="sr-only">Reading who has access…</span>
                        <SkeletonRows :rows="2" control />
                    </template>
                </div>
                <Row v-for="member in members" :key="member.email" icon="user" :title="member.email">
                    <template #control>
                        <!-- The row's role, changeable in place: a re-grade is routine (that is the whole point of
                         tiers), so it must not cost a revoke + re-invite. Ghost rather than a bordered box:
                         the row already has a framed address, a status pill and two buttons on it, and a
                         second box among them read as a form field that had wandered into a list. -->
                        <Picker
                            :model-value="member.role"
                            :options="ROLE_OPTIONS"
                            variant="ghost"
                            :disabled="busy"
                            class="shrink-0"
                            :aria-label="`Role for ${member.email}`"
                            :header="`Role for ${member.email}`"
                            @update:model-value="(role: GrantedRole | undefined) => role !== undefined && setRole(member.email, role)"
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
                        <Button size="small" severity="danger" :text="true" :disabled="busy" aria-label="Revoke access" @click="revoke(member.email)">
                            <template #icon><Icon name="times" /></template>
                        </Button>
                    </template>
                </Row>

                <!-- Invite affordance as the group's footer row (mirrors the Secrets \"add\" pattern). -->
                <RowNote variant="block">
                    <div class="flex flex-col gap-2">
                        <!-- The link goes in the slot, not in the model: it must wrap rather than run out of the
                         box, and it is the one thing on this card a person copies by hand. -->
                        <Notice v-if="notice" :of="notice">
                            <span v-if="handover" class="mt-1 block break-all font-medium">{{ handover }}</span>
                        </Notice>
                        <form class="flex flex-col gap-1.5" @submit.prevent="invite">
                            <!-- Address first, then role beside Invite: the primary flow is "who, send", and the tier
                             is a refinement on that row. Collaborator preselected; the sentence below teaches
                             the model without sitting between two unrelated controls. -->
                            <div class="flex flex-col gap-2 sm:flex-row sm:items-center">
                                <input
                                    v-model="email"
                                    type="email"
                                    autocomplete="off"
                                    placeholder="teammate@example.com"
                                    :class="[
                                        ui.input('min-w-0 sm:flex-1'),
                                        emailTouched && email.trim().length > 0 && !validEmail(email.trim().toLowerCase())
                                            ? 'ui-field-input-error'
                                            : '',
                                    ]"
                                    @blur="emailTouched = true"
                                />
                                <div class="flex items-center gap-2">
                                    <Picker
                                        v-model="inviteRole"
                                        :options="ROLE_OPTIONS"
                                        variant="input"
                                        :disabled="busy"
                                        aria-label="Invite role"
                                        header="Invite as"
                                        class="min-w-0 flex-1 sm:w-36 sm:flex-none"
                                    />
                                    <Button
                                        type="submit"
                                        label="Invite"
                                        :loading="busy"
                                        :disabled="busy || !validEmail(email.trim().toLowerCase())"
                                        class="shrink-0"
                                    >
                                        <template #icon><Icon name="send" /></template>
                                    </Button>
                                </div>
                            </div>
                            <p class="text-xs text-muted">{{ roleHint(inviteRole) }}</p>
                            <span v-if="emailTouched && email.trim().length > 0 && !validEmail(email.trim().toLowerCase())" class="ui-field-error">
                                <Icon name="exclamation-triangle" class="text-2xs" />
                                Enter a valid email address.
                            </span>
                        </form>
                    </div>
                </RowNote>
            </template>

            <template v-else>
                <Row icon="user" :title="user?.email">
                    <template #meta>
                        <span class="rounded-full bg-primary-600/15 px-1.5 py-0.5 text-2xs font-semibold text-link">{{
                            roleLabel(sandbox.active.value?.role ?? `viewer`)
                        }}</span>
                        <span class="rounded-full bg-content/10 px-1.5 py-0.5 text-2xs font-semibold text-subtle">You</span>
                    </template>
                </Row>
                <RowNote>Only the sandbox owner can invite people or change roles.</RowNote>
            </template>
        </RowGroup>

        <!-- The credential kill switch. Owner-only, and separate from the member list above on purpose: this
             answers \"is anything still holding a way in\", not \"who is allowed in\".

             THREE ROWS RATHER THAN A BARE BUTTON, because there is no fourth: the roster this heading implies
             cannot exist (see the note in the script). The rows are the answers to the three questions asked in
             the order the eye arrives at them: what IS signed in that I can see, why can't I see the rest, and
             what exactly happens if I press this. -->
        <RowGroup v-if="isOwner" label="Signed-in browsers">
            <!-- The one signed-in browser the app can name, because it is running in it. -->
            <Row icon="desktop" title="This browser" :description="thisBrowser">
                <template #meta><span class="text-success">Signed in</span></template>
            </Row>

            <!-- The empty list, explained where the reader asks about it, rather than left as a blank surface. -->
            <Row
                icon="shield"
                title="Other browsers aren't listed"
                description="Each browser keeps its own signed pass and the sandbox stores nothing per device, so there is no list to show — and no device that could quietly stay off one. Signing out covers all of them at once."
            />

            <Row icon="sign-out" tone="danger" title="Sign out everywhere">
                <template #description>
                    Ends every pass, this browser's included, though you stay signed in here. Everyone else signs in again and gets back in only if
                    they're still on the list above.
                </template>
                <template #control>
                    <!-- Arming clears the last run's receipt: the row has one thing to say at a time, and
                         "every browser has been signed out" under a live "are you sure?" is two. -->
                    <Button
                        v-if="!confirmingRevoke"
                        label="Sign out all browsers"
                        severity="danger"
                        size="small"
                        :disabled="revokingSessions"
                        @click="
                            sessionsRevoked = false;
                            confirmingRevoke = true;
                        "
                    >
                        <template #icon><Icon name="sign-out" /></template>
                    </Button>
                </template>
                <template v-if="confirmingRevoke || sessionsRevoked" #below>
                    <div v-if="confirmingRevoke" class="flex flex-wrap items-center justify-end gap-2">
                        <span class="mr-auto text-2xs text-subtle">Sure? Everyone working in this sandbox right now has to sign in again.</span>
                        <Button
                            label="Cancel"
                            severity="secondary"
                            :text="true"
                            size="small"
                            :disabled="revokingSessions"
                            @click="confirmingRevoke = false"
                        />
                        <Button label="Sign out all browsers" severity="danger" size="small" :loading="revokingSessions" @click="revokeSessions" />
                    </div>
                    <p v-if="sessionsRevoked" class="flex items-center gap-1.5 text-xs font-semibold text-success">
                        <Icon name="check-circle" /> Every browser has been signed out. Any device still holding a pass is locked out now.
                    </p>
                </template>
            </Row>
        </RowGroup>

        <!-- Live presence: who else is connected right now (everyone sees this). -->
        <RowGroup label="Here now">
            <RowNote v-if="presenceOthers.length === 0" variant="empty">No one else is connected right now.</RowNote>
            <template v-else>
                <Row
                    v-for="member in presenceOthers"
                    :key="member.email"
                    :class="member.idle ? 'opacity-60' : ''"
                    :title="member.name ?? member.email"
                    :description="presenceActivity(member)"
                >
                    <!-- The avatar is the row's mark, so it takes the row's mark size (32 was this file's own
                         guess at it, against 22 on every other record list in the hub). -->
                    <template #lead="{ mark }">
                        <Avatar :size="mark" :name="member.name ?? member.email" :src="member.picture" :hue="identityHue(member.email)" />
                    </template>
                    <template #meta>
                        <!-- The role rides presence: who may do what is a fact every member gets to see. -->
                        <span class="rounded-full bg-content/10 px-1.5 py-0.5 text-2xs font-medium text-subtle">{{ roleLabel(member.role) }}</span>
                        <span v-if="member.idle">idle</span>
                    </template>
                </Row>
            </template>
        </RowGroup>
    </div>
</template>
