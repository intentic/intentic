<script setup lang="ts">
import type { InviteDelivery, InviteRecord } from "@intentic/api-contract";
import type { GrantedRole } from "@intentic/sandbox-contract";
import { plural } from "@intentic/base/format";
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
    StatusBadge,
    type StatusVariant,
    ui,
} from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { formatDate } from "@intentic/ui/format";
import { computed, onMounted, ref } from "vue";
import { sandboxJson } from "../client/sandboxClient";
import { jsonBody } from "../client/jsonBody";
import { apiClient } from "../../../lib/useApi";
import { useAuth } from "../../auth/useAuth";
import { useSandbox } from "../client/useSandbox";
import { useSandboxSession } from "../session/sandboxSession";
import { useSandboxOutline } from "../overview/useSandboxOutline";
import { identityHue } from "../../../lib/identityHue";
import { presenceActivity, presenceOthers } from "../../../shell/presence/usePresence";
import { useAccessInventory } from "./useAccessInventory";
import ControlTokensSection from "./ControlTokensSection.vue";
import DeskPicker from "./DeskPicker.vue";
import PasskeysSection from "./PasskeysSection.vue";
import { type AccessGrant, grantBody, grantSendable } from "./accessGrant";
import { useT } from "@intentic/ui/i18n";

// Owner-only invites: daemon's enforced /members list first, fail-closed (sandboxJson throws on non-2xx), then the
// platform's record + email, each with its own error. A declined or refused send isn't a failure, since the grant is
// already recorded; the owner gets the link instead. Members get read-only; presence is for everyone.

const t = useT();

const { user } = useAuth();
const sandbox = useSandbox();
const { sessionExpiresAt } = useSandboxSession();

const isOwner = computed(() => sandbox.active.value?.role === `owner`);

const members = ref<InviteRecord[]>([]);
const email = ref(``);

// Tiers an invite can grant, nested order, shared by the invite form and every roster row's <Picker>.
const ROLE_OPTIONS = computed((): readonly PickerOption<GrantedRole>[] => [
    { label: t(`sandbox.sandboxAccess.viewer`), value: `viewer`, icon: `eye`, hint: t(`sandbox.sandboxAccess.watchEverythingAgentsChats`) },
    {
        label: t(`sandbox.sandboxAccess.collaborator`),
        value: `collaborator`,
        icon: `users`,
        // Files-through-agents is the clause people miss; collaborators land and publish only as requests.
        hint: t(`sandbox.sandboxAccess.driveAgentsReviewWork`),
    },
    {
        label: t(`sandbox.sandboxAccess.maintainer`),
        value: `maintainer`,
        icon: `wrench`,
        hint: t(`sandbox.sandboxAccess.operateEverythingOwnerOwner`),
    },
    // Below viewer: talks to the cards it holds and is shown nothing else. Listed last, since it is the narrowest.
    {
        label: t(`sandbox.sandboxAccess.desk`),
        value: `desk`,
        icon: `comments`,
        hint: t(`sandbox.sandboxAccess.deskTalksToAssistants`),
    },
]);
const inviteRole = ref<GrantedRole>(`collaborator`);
// The cards a desk invite hands over; kept when the tier flips away and back, sent only on a desk grant.
const inviteDesks = ref<string[]>([]);
// The daemon's own roster, the one copy that knows a desk's cards; the platform's records above carry the tier only.
const grants = ref<readonly AccessGrant[]>([]);
const desksOf = (address: string): readonly string[] => grants.value.find((grant) => grant.email === address.toLowerCase())?.desks ?? [];
const busy = ref(false);
// The one thing this tab has to say right now: a failure, or an invite whose link the owner must carry.
const notice = ref<NoticeModel>();

// Accept link the owner carries when mail didn't; beside `notice`, not inside it, since a link is markup.
const handover = ref<string>();

// Other doors, counted, not managed here; answers what else can reach the sandbox without a person.
const { inventory, loading: inventoryLoading } = useAccessInventory();

const webhooksLine = computed(() =>
    inventory.value.webhooks === undefined
        ? `Not readable right now.`
        : `${plural(inventory.value.webhooks, `event automation`, `event automations`)}, each with its own webhook URL and token. Rotate or remove one on its row in Automations.`,
);
const gatesLine = computed(() =>
    inventory.value.gates === undefined
        ? `Not readable right now.`
        : `${plural(inventory.value.gates, `gated workflow`, `gated workflows`)}, each answering a pipeline at its own URL and token. Managed in the workflow designer's gate panel.`,
);
const ciLine = computed(() => {
    const repos = inventory.value.ciRepos;
    if (repos === undefined) {
        return `Not readable right now.`;
    }
    if (repos.total === 0) {
        return `No repository is wired to a forge. Connect GitHub or GitLab to receive pipeline results.`;
    }
    return `${plural(repos.total, `repository`, `repositories`)} wired to a forge, ${repos.hooked} with a webhook the sandbox registered and signs with a per-sandbox secret. The rest are polled. Details on Pipelines.`;
});

// Clears both together; a link with no sentence, or vice versa, is worse than neither.
const clearNotice = (): void => {
    notice.value = undefined;
    handover.value = undefined;
};

const emailTouched = ref(false);

const validEmail = (value: string): boolean => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value);

// Tone is a severity ramp, not a role palette: accepted stays quiet; only the waiting states get colour.
const STATUS: Record<InviteRecord["status"], { label: string; variant: StatusVariant; dot: boolean }> = {
    accepted: { label: `member`, variant: `neutral`, dot: false },
    pending: { label: `pending`, variant: `info`, dot: true },
    expired: { label: `expired`, variant: `danger`, dot: false },
};

// True until the mount fetch lands; every later refresh rides a write's own response, never blank again.
const listing = ref(true);

const load = async (): Promise<void> => {
    const id = sandbox.activeSandboxId.value;
    if (id === undefined) {
        listing.value = false;
        return;
    }
    clearNotice();
    try {
        // Both rosters, since only the daemon's says which cards a desk holds; a daemon that isn't answering leaves the
        // chips blank rather than the list.
        const [invited, granted] = await Promise.all([
            apiClient.invite.list({ sandboxId: id }),
            sandboxJson<{ members: AccessGrant[] }>(`/members`).catch((): { members: AccessGrant[] } => ({ members: [] })),
        ]);
        members.value = invited.members;
        grants.value = granted.members;
    } catch (err) {
        notice.value = noticeFrom(err, `Couldn't load the access list.`);
    } finally {
        listing.value = false;
    }
};

// Placeholder rows while the roster loads, so the tab doesn't open claiming nobody's invited.
const outline = useSandboxOutline(listing);

// Invite list is owner-only (the API 403s a member); load only when the viewer owns this sandbox.
onMounted(() => {
    if (isOwner.value) {
        void load();
        return;
    }
    // A member never fetches; leaving `listing` true would outline a list that never arrives.
    listing.value = false;
});

// Not an error: already invited, just unreachable by mail; `sent` needs no entry here.
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
                      label: t(`sandbox.sandboxAccess.copyLink`),
                      // Uses the clicked element's own window; best-effort, so a refusal here isn't the invite failing.
                      run: () => void Promise.resolve(clipboardOf(document.activeElement)?.writeText(result.link)).catch(() => undefined),
                  },
              };
};

const invite = async (): Promise<void> => {
    const id = sandbox.activeSandboxId.value;
    const value = email.value.trim().toLowerCase();
    if (id === undefined || busy.value || !validEmail(value) || !grantSendable(inviteRole.value, inviteDesks.value)) {
        return;
    }
    busy.value = true;
    clearNotice();
    try {
        // Daemon push first, enforced; sandboxJson throws on non-2xx, so an unenforced grant is never recorded as sent.
        try {
            grants.value = (
                await sandboxJson<{ members: AccessGrant[] }>(`/members`, jsonBody(`POST`, grantBody(value, inviteRole.value, inviteDesks.value)))
            ).members;
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
        // Platform refused after the daemon granted; resync so the roster shows what's actually true.
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

// No device roster can exist: a session is a signed claim the daemon verifies, not stored. The group says what's true:
// this browser, why the rest are unlistable, and the switch's consequence.
const revokingSessions = ref(false);
const sessionsRevoked = ref(false);
// Armed before firing: irreversible, signs out everyone, and can't be aimed at one device.
const confirmingRevoke = ref(false);

// A date, not a countdown: the expiry slides forward on renewal, so it reads as neglect risk, not a deadline.
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

// Re-grades with the same two-write, daemon-first order as a grant; applies on the member's next request. A row
// re-graded to desk keeps the cards it last held, or waits for the picker below it to name one.
const setRole = async (target: string, role: GrantedRole, desks: readonly string[] = desksOf(target)): Promise<void> => {
    const id = sandbox.activeSandboxId.value;
    if (id === undefined || busy.value || !grantSendable(role, desks)) {
        return;
    }
    busy.value = true;
    clearNotice();
    try {
        // Same split as the grant: only the first of the two writes can be a sandbox that isn't answering.
        try {
            grants.value = (await sandboxJson<{ members: AccessGrant[] }>(`/members`, jsonBody(`POST`, grantBody(target, role, desks)))).members;
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
        // Enforcer drops access first; a rejecting/offline daemon errors instead of leaving access standing.
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
        <!-- Rows use <Row>, taking the group's own tier, like every other list in the app. -->
        <RowGroup :label="t(`sandbox.sandboxAccess.access`)">
            <template v-if="isOwner">
                <Row icon="user" :title="user?.email">
                    <template #meta><StatusBadge variant="primary" :label="t(`sandbox.sandboxAccess.owner`)" size="xs" /></template>
                </Row>
                <div v-if="listing" role="status" aria-busy="true">
                    <template v-if="outline">
                        <span class="sr-only">{{ t(`sandbox.sandboxAccess.readingWhoAccess`) }}</span>
                        <SkeletonRows :rows="2" control />
                    </template>
                </div>
                <template v-for="member in members" :key="member.email">
                <Row icon="user" :title="member.email">
                    <!-- Status belongs in metadata, not the action slot. -->
                    <template #meta>
                        <StatusBadge
                            :variant="STATUS[member.status].variant"
                            :label="STATUS[member.status].label"
                            :dot="STATUS[member.status].dot"
                            size="xs"
                        />
                        <!-- A desk's cards, named on the row: the whole of what that person reaches. -->
                        <StatusBadge v-for="desk in desksOf(member.email)" :key="desk" variant="neutral" :label="desk" size="xs" />
                    </template>
                    <template #control>
                        <!-- Changeable in place, since a re-grade is routine and shouldn't cost a revoke + re-invite. -->
                        <Picker
                            :model-value="member.role"
                            :options="ROLE_OPTIONS"
                            variant="ghost"
                            :disabled="busy"
                            class="shrink-0"
                            :aria-label="t(`sandbox.sandboxAccess.role`, { email: member.email })"
                            :header="t(`sandbox.sandboxAccess.role`, { email: member.email })"
                            @update:model-value="(role: GrantedRole | undefined) => role !== undefined && setRole(member.email, role)"
                        />
                        <Button
                            v-if="member.status !== 'accepted'"
                            :label="t(`sandbox.sandboxAccess.resend`)"
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
                            :disabled="busy"
                            :aria-label="t(`sandbox.sandboxAccess.revokeAccess`)"
                            @click="revoke(member.email)"
                        >
                            <template #icon><Icon name="times" /></template>
                        </Button>
                    </template>
                </Row>
                <!-- Which cards a desk holds, changed in place; a re-grade to desk lands here until it names one. -->
                <RowNote v-if="member.role === 'desk'" variant="block">
                    <DeskPicker :picked="desksOf(member.email)" :disabled="busy" @change="(desks) => setRole(member.email, `desk`, desks)" />
                </RowNote>
                </template>

                <!-- Invite affordance as the group's footer row (mirrors the Secrets \"add\" pattern). -->
                <RowNote variant="block">
                    <div class="flex flex-col gap-2">
                        <!-- Links use the slot so long values can wrap. -->
                        <Notice v-if="notice" :of="notice">
                            <span v-if="handover" class="mt-1 block break-all font-medium">{{ handover }}</span>
                        </Notice>
                        <form class="flex flex-col gap-1.5" @submit.prevent="invite">
                            <!-- Address first, role beside Invite, since inviting is the primary action and the tier a refinement. -->
                            <!-- Wraps on its own width, not the window's: this form sits in a pane the docked chat can leave 20rem wide on a screen the `sm:` breakpoint calls roomy. -->
                            <div class="flex flex-wrap items-center gap-2">
                                <input
                                    v-model="email"
                                    type="email"
                                    autocomplete="off"
                                    placeholder="teammate@example.com"
                                    :class="[
                                        ui.inputSm('min-w-0 flex-1 basis-56'),
                                        emailTouched && email.trim().length > 0 && !validEmail(email.trim().toLowerCase())
                                            ? 'ui-field-error-box'
                                            : '',
                                    ]"
                                    @blur="emailTouched = true"
                                />
                                <div class="ml-auto flex shrink-0 items-center gap-2">
                                    <Picker
                                        v-model="inviteRole"
                                        :options="ROLE_OPTIONS"
                                        variant="input"
                                        :disabled="busy"
                                        :aria-label="t(`sandbox.sandboxAccess.inviteRole`)"
                                        :header="t(`sandbox.sandboxAccess.invite`)"
                                        class="ui-field-sm w-36 min-w-0"
                                    />
                                    <Button
                                        type="submit"
                                        :label="t(`sandbox.sandboxAccess.invite2`)"
                                        size="small"
                                        :loading="busy"
                                        :disabled="busy || !validEmail(email.trim().toLowerCase()) || !grantSendable(inviteRole, inviteDesks)"
                                        class="shrink-0"
                                    >
                                        <template #icon><Icon name="send" /></template>
                                    </Button>
                                </div>
                            </div>
                            <span v-if="emailTouched && email.trim().length > 0 && !validEmail(email.trim().toLowerCase())" class="ui-field-error">
                                <Icon name="exclamation-triangle" class="text-2xs" />
                                {{ t(`sandbox.sandboxAccess.enterValidEmailAddress`) }}
                            </span>
                            <!-- A desk is nothing without its cards, so the pick sits on the invite itself. -->
                            <DeskPicker v-if="inviteRole === 'desk'" :picked="inviteDesks" :disabled="busy" @change="(desks) => (inviteDesks = desks)" />
                        </form>
                    </div>
                </RowNote>
            </template>

            <template v-else>
                <Row icon="user" :title="user?.email">
                    <template #meta>
                        <StatusBadge variant="primary" :label="sandbox.active.value?.role ?? `viewer`" size="xs" />
                        <StatusBadge variant="neutral" :label="t(`sandbox.sandboxAccess.you`)" size="xs" />
                    </template>
                </Row>
                <RowNote>{{ t(`sandbox.sandboxAccess.onlySandboxOwnerInvite`) }}</RowNote>
            </template>
        </RowGroup>

        <!-- How people prove themselves to this sandbox, before what programs hold. -->
        <PasskeysSection />

        <!-- Program credentials follow people and include every sandbox token. -->
        <ControlTokensSection />

        <!-- Credential revocation answers whether any access remains active. -->
        <RowGroup v-if="isOwner" :label="t(`sandbox.sandboxAccess.signedInBrowsers`)">
            <!-- The one signed-in browser the app can name, because it is running in it. -->
            <Row icon="desktop" :title="t(`sandbox.sandboxAccess.browser`)" :description="thisBrowser">
                <template #meta><StatusBadge variant="success" :label="t(`sandbox.sandboxAccess.signedIn`)" size="xs" /></template>
            </Row>

            <!-- The empty list, explained where the reader asks about it, rather than left as a blank surface. -->
            <Row
                icon="shield"
                :title="t(`sandbox.sandboxAccess.otherBrowsersArentListed`)"
                :description="t(`sandbox.sandboxAccess.sandboxDoesntTrackDevices`)"
            />

            <Row icon="sign-out" tone="danger" :title="t(`sandbox.sandboxAccess.signOutEverywhere`)">
                <template #description>{{ t(`sandbox.sandboxAccess.revokesEveryPassStay`) }}</template>
                <template #control>
                    <!-- Clears the last run's receipt; the row says one thing at a time, not a stale result under a live confirm. -->
                    <Button
                        v-if="!confirmingRevoke"
                        :label="t(`sandbox.sandboxAccess.signOutAllBrowsers`)"
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
                        <span class="mr-auto text-2xs text-subtle">{{ t(`sandbox.sandboxAccess.sureEveryoneWorkingIn`) }}</span>
                        <Button
                            :label="t(`ui.action.cancel`)"
                            severity="secondary"
                            :text="true"
                            size="small"
                            :disabled="revokingSessions"
                            @click="confirmingRevoke = false"
                        />
                        <Button
                            :label="t(`sandbox.sandboxAccess.signOutAllBrowsers`)"
                            severity="danger"
                            size="small"
                            :loading="revokingSessions"
                            @click="revokeSessions"
                        />
                    </div>
                    <p v-if="sessionsRevoked" class="flex items-center gap-1.5 text-xs font-semibold text-success">
                        <Icon name="check-circle" /> {{ t(`sandbox.sandboxAccess.everyBrowserSignedOut`) }}
                    </p>
                </template>
            </Row>
        </RowGroup>

        <!-- Machine access other than sign-ins and tokens is listed separately. -->
        <RowGroup v-if="isOwner" :label="t(`sandbox.sandboxAccess.otherWaysIn`)">
            <div v-if="inventoryLoading" role="status" aria-busy="true"><SkeletonRows :rows="3" /></div>
            <template v-else>
                <Row icon="bolt" :title="t(`sandbox.sandboxAccess.webhooks`)" :description="webhooksLine" />
                <Row icon="shield" :title="t(`sandbox.sandboxAccess.releaseGates`)" :description="gatesLine" />
                <Row icon="sitemap" :title="t(`sandbox.sandboxAccess.ciNotifications`)" :description="ciLine" />
                <Row
                    icon="desktop"
                    :title="t(`sandbox.sandboxAccess.pairedDevicesRunners`)"
                    :description="t(`sandbox.sandboxAccess.eachHoldsOwnEnrollment`)"
                />
            </template>
        </RowGroup>

        <!-- Live presence: who else is connected right now (everyone sees this). -->
        <RowGroup :label="t(`sandbox.sandboxAccess.hereNow`)">
            <RowNote v-if="presenceOthers.length === 0" variant="empty">{{ t(`sandbox.sandboxAccess.noOneElseConnected`) }}</RowNote>
            <template v-else>
                <Row
                    v-for="member in presenceOthers"
                    :key="member.email"
                    :class="member.idle ? 'opacity-60' : ''"
                    :title="member.name ?? member.email"
                    :description="presenceActivity(member)"
                >
                    <!-- Avatar takes the row's own mark size, not a guessed one. -->
                    <template #lead="{ mark }">
                        <Avatar :size="mark" :name="member.name ?? member.email" :src="member.picture" :hue="identityHue(member.email)" />
                    </template>
                    <template #meta>
                        <!-- The role rides presence: who may do what is a fact every member gets to see. -->
                        <StatusBadge variant="neutral" :label="member.role" size="xs" />
                        <span v-if="member.idle">{{ t(`sandbox.sandboxAccess.idle`) }}</span>
                    </template>
                </Row>
            </template>
        </RowGroup>
    </div>
</template>
