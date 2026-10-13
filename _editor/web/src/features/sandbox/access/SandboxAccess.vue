<script setup lang="ts">
import type { InviteDelivery, InviteRecord } from "@intentic/api-contract";
import type { MemberGrant } from "@intentic/sandbox-contract";
import {
    Avatar,
    Button,
    clipboardOf,
    Notice,
    type IconName,
    type NoticeModel,
    Row,
    RowGroup,
    RowNote,
    SkeletonRows,
    SkeletonSnapshot,
    StatusBadge,
    type StatusVariant,
    vSkeletonSource,
} from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { formatDate } from "@intentic/ui/format";
import { computed, onMounted, ref, watch } from "vue";
import { sandboxRaw } from "../../../client/sandbox/sandboxRaw";
import { apiClient } from "../../../lib/useApi";
import { grantMember, revokeMember, useMembers } from "../../../client/sandbox/useMembers";
import { useAuth } from "../../../client/auth/useAuth";
import { useSandbox } from "../../../client/sandbox/useSandbox";
import { useRole } from "../../../client/sandbox/useRole";
import { useSandboxSession } from "../../../client/session/sandboxSession";
import { useSandboxOutline } from "../overview/useSandboxOutline";
import { useAreas } from "../areas/useAreas";
import { identityHue } from "../../../lib/identityHue";
import { presenceActivity, presenceOthers } from "../../../workbench/presence/usePresence";
import { useAccessInventory } from "./useAccessInventory";
import ControlTokensSection from "./ControlTokensSection.vue";
import PasskeysSection from "./PasskeysSection.vue";
import { type AccessDraft, draftGrant, grantSendable, roleBounded, roleDrivesAgents } from "./accessGrant";
import { usePersonaReach } from "./usePersonaReach";
import PersonAccessDialog from "./PersonAccessDialog.vue";
import StandingGrants from "./StandingGrants.vue";
import { useOperation } from "../../../workbench/operations/operations";
import { useT } from "@intentic/ui/i18n";

// Owner-only invites: daemon's enforced /members list first, fail-closed (sandboxRaw throws on non-2xx), then the
// platform's record + email, each with its own error. A declined or refused send isn't a failure, since the grant is
// already recorded; the owner gets the link instead. Members get read-only; presence is for everyone.

const t = useT();

const { user } = useAuth();
const sandbox = useSandbox();
const { sessionExpiresAt } = useSandboxSession();

const isOwner = computed(() => sandbox.active.value?.role === `owner`);
// Everything on this tab but the roster is operating authority, which a maintainer holds as the owner does: signing
// every browser out is maintainer and up at the daemon (`ownerDenied`), and the door counts below read at viewer. Only
// inviting and re-grading people stays the owner's (`isOwner`).
const { canShip } = useRole();

// The platform's invite records: who was invited and how that stands. The daemon's own roster is `grants` below.
const members = ref<InviteRecord[]>([]);

// Each tier in the words the rest of the app uses for it; a role this build does not know reads as itself.
const roleLabel = (role: string): string =>
    ({
        guest: t(`sandbox.sandboxAccess.guest`),
        viewer: t(`sandbox.sandboxAccess.viewer`),
        collaborator: t(`sandbox.sandboxAccess.collaborator`),
        writer: t(`sandbox.sandboxAccess.writer`),
        maintainer: t(`sandbox.sandboxAccess.maintainer`),
        owner: t(`sandbox.sandboxAccess.owner`),
    })[role] ?? role;
// The reader's own tier, for the row a member sees of themselves.
const ownRole = computed((): string => roleLabel(sandbox.active.value?.role ?? `viewer`));

// The daemon's own roster, the one copy that knows a fence and a reach; the platform's records above carry the tier
// only. It is the members cache entry (useMembers), which a grant or revoke here fills with the roster the daemon
// answers, so this tab holds no copy of its own and the board's Everyone/Mine row reads the same list. Only the owner
// reads it.
const { roster, members: grants, error: grantsError } = useMembers({ enabled: isOwner });
// Why that roster could not be read. While set no row's fence or reach is known, and a grant replaces the whole row, so
// an edit sent now would drop what it holds and widen what the member sees: no grant is rewritten until it clears.
const grantsUnread = computed<NoticeModel | undefined>(() =>
    grantsError.value === undefined
        ? undefined
        : noticeFrom(new Error(grantsError.value), t(`sandbox.sandboxAccess.couldntReadMemberAreas`), { tone: `warning` }),
);
// Whether the fences are not known: the roster could not be read, or has not been (a sandbox that is not answering never
// starts the read). No row is edited then, for the same reason.
const fencesUnknown = computed(() => grantsUnread.value !== undefined || roster.value === undefined);
const grantOf = (address: string) => grants.value.find((grant) => grant.email === address.toLowerCase());
// Which assistants a fence hands over: derived from where each card works, never picked per person.
const { namesOf } = usePersonaReach();
// An area is named on the row the way it is on its own page; an id with no area behind it reads as itself, since
// the person still holds it. Held for a guest, the one tier the daemon refuses this read to.
const { labelOf: areaLabel } = useAreas(() => sandbox.active.value?.role !== `guest`);

// WHAT A ROW SAYS of a person, in one line under their address: where they work, then what their assistants may
// spend. For a guest the assistants they talk to are the whole of their access, so those are named instead of folders.
const accessLine = (member: InviteRecord): string => {
    const grant = grantOf(member.email);
    const role = grant?.role ?? member.role;
    if (!roleBounded(role)) {
        return t(`sandbox.sandboxAccess.lineMaintainer`);
    }
    const where =
        role === `guest`
            ? namesOf(grant?.areas).length === 0
                ? t(`sandbox.sandboxAccess.guestReachesNobody`)
                : t(`sandbox.sandboxAccess.guestReaches`, { names: namesOf(grant?.areas).join(`, `) })
            : grant?.areas === undefined
              ? t(`sandbox.sandboxAccess.wholeWorkspace`)
              : grant.areas.map((area) => areaLabel(area)).join(`, `);
    if (!roleDrivesAgents(role)) {
        return where;
    }
    const reach = grant?.credentials;
    const uses =
        reach === undefined
            ? t(`sandbox.sandboxAccess.lineEverything`)
            : reach.capabilities.length + reach.secrets.length === 0
              ? t(`sandbox.sandboxAccess.lineNothing`)
              : [
                    ...(reach.capabilities.length > 0
                        ? [t(`sandbox.sandboxAccess.lineAccounts`, { count: reach.capabilities.length }, reach.capabilities.length)]
                        : []),
                    ...(reach.secrets.length > 0 ? [t(`sandbox.sandboxAccess.lineSecrets`, { count: reach.secrets.length }, reach.secrets.length)] : []),
                ].join(`, `);
    return `${where} · ${uses}`;
};

// THE PERSON DIALOG: adding someone and changing what someone holds are one form. `editingEmail` is who it is open on;
// none is a new invite.
const dialogOpen = ref(false);
const editingEmail = ref<string>();
const editing = computed(() => {
    const member = members.value.find((record) => record.email === editingEmail.value);
    return member === undefined ? undefined : { email: member.email, pending: member.status !== `accepted` };
});
// A new teammate's usual grant: drives agents across the workspace with what the sandbox has connected. Editing opens
// on what the daemon holds for them, the platform's tier standing in only for a row the daemon never wrote.
const NEW_PERSON: AccessDraft = { role: `collaborator`, areas: undefined, emailSignIn: false, credentials: `all` };
const initialDraft = computed((): AccessDraft => {
    const member = editing.value === undefined ? undefined : members.value.find((record) => record.email === editing.value?.email);
    if (member === undefined) {
        return NEW_PERSON;
    }
    const grant = grantOf(member.email);
    return {
        role: grant?.role ?? member.role,
        areas: grant?.areas,
        emailSignIn: grant?.emailSignIn === true,
        credentials: grant?.credentials ?? `all`,
    };
});
// Whether a grant at this tier, fenced this way, is one the daemon will take.
const sendable = (draft: AccessDraft): boolean => grantSendable(draft.role, draft.areas, namesOf(draft.areas).length);

// THE ROSTER WRITES ARE THE SANDBOX'S, NOT THIS TAB'S. An invite, a resend, a re-grade and a revoke are each two writes
// (the daemon's enforced list, then the platform's record), one at a time, and they live in the operations ledger: the
// tab opened again mid-write holds its buttons, and the accept link of an invite mail could not deliver is kept until
// the owner moves on to the next write, since it can only be read here.
// What a write answers: the platform's roster, and for an invite or a resend, how it went out. The daemon's roster is
// not among them: it lands in the members cache entry as the daemon answers it.
interface RosterWrite {
    readonly members?: InviteRecord[];
    readonly delivery?: { readonly link: string; readonly delivery: InviteDelivery; readonly reason?: string };
}
// A refusal, and whether the roster on screen may no longer be true: the daemon granted, then the platform refused.
interface RosterRefusal {
    readonly notice: NoticeModel;
    readonly reload: boolean;
}
// The daemon's refusal, the first of the two writes: nothing changed, and it carries its own sentence.
class DaemonRefused extends Error {
    constructor(
        readonly sentence: string,
        readonly reason: unknown,
    ) {
        super(sentence);
    }
}
const refusedAs =
    (recording: string) =>
    (error: unknown): RosterRefusal =>
        error instanceof DaemonRefused
            ? { notice: noticeFrom(error.reason, error.sentence), reload: false }
            : { notice: noticeFrom(error, recording), reload: true };
const writes = useOperation<RosterWrite, RosterRefusal>(`access/members/write`);
const busy = writes.busy;
// The sign-out is the sandbox's too: opened again mid-request, the tab holds the button and then says it was done.
const sessions = useOperation(`access/sessions/revoke`);

// What this tab decided by itself (a roster it couldn't read, a re-grade it won't send), beside the writes' own words.
const localNotice = ref<NoticeModel>();
// The delivery an invite or resend reported, when mail did not carry it.
const undelivered = computed(() => {
    const delivered = writes.operation.value?.state === `done` ? writes.value.value?.delivery : undefined;
    return delivered === undefined || delivered.delivery === `sent` ? undefined : delivered;
});
const deliveryNotice = computed((): NoticeModel | undefined => {
    const result = undelivered.value;
    return result === undefined || result.delivery === `sent`
        ? undefined
        : {
              tone: `warning`,
              title: deliveryNote(result.delivery),
              detail: result.reason,
              action: {
                  label: t(`ui.action.copyLink`),
                  // Uses the clicked element's own window; best-effort, so a refusal here isn't the invite failing.
                  run: () => void Promise.resolve(clipboardOf(document.activeElement)?.writeText(result.link)).catch(() => undefined),
              },
          };
});
// The one thing this tab has to say right now: a failure, or an invite whose link the owner must carry.
const notice = computed(
    () => localNotice.value ?? writes.failure.value?.notice ?? sessions.failure.value ?? deliveryNotice.value,
);
// Accept link the owner carries when mail didn't; beside `notice`, not inside it, since a link is markup.
const handover = computed(() => (notice.value !== undefined && notice.value === deliveryNotice.value ? undelivered.value?.link : undefined));

// Other doors, counted, not managed here; answers what else can reach the sandbox without a person.
const { inventory, loading: inventoryLoading } = useAccessInventory();

// Only doors in use are listed: a count of zero is a door nobody opened, so it says nothing here. A count the daemon
// could not read stays, since an unread door is not a closed one.
// "2 devices", "1 runner", or both: a kind nobody paired is left out of the sentence rather than counted as zero.
const pairedWhat = (devices: number, runners: number): string => {
    const devicesPart = t(`sandbox.sandboxAccess.pairedDevices`, { count: devices }, devices);
    const runnersPart = t(`sandbox.sandboxAccess.pairedRunners`, { count: runners }, runners);
    if (devices > 0 && runners > 0) {
        return t(`sandbox.sandboxAccess.pairedBoth`, { devices: devicesPart, runners: runnersPart });
    }
    return devices > 0 ? devicesPart : runnersPart;
};
const notReadable = (): string => t(`sandbox.sandboxAccess.notReadableRightNow`);
const doors = computed(() => {
    const { webhooks, gates, ciRepos, paired } = inventory.value;
    const rows: { key: string; icon: IconName; title: string; description: string }[] = [];
    if (webhooks !== 0) {
        rows.push({
            key: `webhooks`,
            icon: `bolt`,
            title: t(`sandbox.sandboxAccess.webhooks`),
            description: webhooks === undefined ? notReadable() : t(`sandbox.sandboxAccess.webhooksLine`, { count: webhooks }, webhooks),
        });
    }
    if (gates !== 0) {
        rows.push({
            key: `gates`,
            icon: `shield`,
            title: t(`sandbox.sandboxAccess.releaseGates`),
            description: gates === undefined ? notReadable() : t(`sandbox.sandboxAccess.gatesLine`, { count: gates }, gates),
        });
    }
    if (ciRepos?.total !== 0) {
        rows.push({
            key: `ci`,
            icon: `sitemap`,
            title: t(`sandbox.sandboxAccess.ciNotifications`),
            description:
                ciRepos === undefined
                    ? notReadable()
                    : t(`sandbox.sandboxAccess.ciLine`, { count: ciRepos.total, hooked: ciRepos.hooked }, ciRepos.total),
        });
    }
    if (paired === undefined || paired.devices + paired.runners > 0) {
        rows.push({
            key: `paired`,
            icon: `desktop`,
            title: t(`sandbox.sandboxAccess.pairedDevicesRunners`),
            description:
                paired === undefined
                    ? notReadable()
                    : t(`sandbox.sandboxAccess.pairedLine`, { what: pairedWhat(paired.devices, paired.runners) }),
        });
    }
    return rows;
});

// Clears what this tab has to say before the next write: the link went with the notice, and a link with no sentence,
// or vice versa, is worse than neither.
const clearNotice = (): void => {
    localNotice.value = undefined;
    writes.dismiss();
    sessions.dismiss();
};

// Tone is a severity ramp, not a role palette: accepted stays quiet; only the waiting states get colour.
// Built when read, so the labels follow a language switch.
const statusOf = (status: InviteRecord["status"]): { label: string; variant: StatusVariant; dot: boolean } =>
    ({
        accepted: { label: t(`sandbox.sandboxAccess.statusMember`), variant: `neutral` as const, dot: false },
        pending: { label: t(`sandbox.sandboxAccess.statusPending`), variant: `info` as const, dot: true },
        expired: { label: t(`sandbox.sandboxAccess.statusExpired`), variant: `danger` as const, dot: false },
    })[status];

// True until the mount fetch lands; every later refresh rides a write's own response, never blank again.
const listing = ref(true);

const load = async (): Promise<void> => {
    const id = sandbox.activeSandboxId.value;
    if (id === undefined) {
        listing.value = false;
        return;
    }
    // Only this tab's own words: an invite's link kept in the ledger outlives the tab being opened again.
    localNotice.value = undefined;
    try {
        // The platform's records only: the daemon's roster, the one that says which cards a guest holds, is its own cache
        // entry. One that isn't answering leaves the list up and says the fences are unknown (`grantsUnread`), rather
        // than drawing every row as unfenced.
        members.value = (await apiClient.invite.list({ sandboxId: id })).members;
    } catch (err) {
        localNotice.value = noticeFrom(err, t(`sandbox.sandboxAccess.couldntLoadAccessList`));
    } finally {
        listing.value = false;
    }
};

// A write's answer is the platform's roster as it now stands, put on screen by whichever mount of this tab is up when it
// lands; a write refused after the daemon granted leaves the screen unsure, so the platform's roster is read again (the
// daemon's is already the cache's).
watch(
    () => writes.operation.value,
    (now, before) => {
        if (before?.state !== `running` || now === undefined || now.order !== before.order || now.state === `running`) {
            return;
        }
        if (now.state === `failed`) {
            if (now.failure?.reload === true) {
                void load();
            }
            return;
        }
        if (now.value?.members !== undefined) {
            members.value = now.value.members;
        }
    },
);

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
// Built when read, so the note follows a language switch.
const deliveryNote = (delivery: Exclude<InviteDelivery, "sent">): string =>
    ({
        unconfigured: t(`sandbox.sandboxAccess.deliveryUnconfigured`),
        "local-link": t(`sandbox.sandboxAccess.deliveryLocalLink`),
        refused: t(`sandbox.sandboxAccess.deliveryRefused`),
    })[delivery];

// Daemon push first, enforced; sandboxRaw throws on non-2xx, so an unenforced grant is never recorded as sent. Its
// answer is the daemon's whole roster, which lands in the members cache entry (useMembers) whole.
const grantOnDaemon = async (grant: MemberGrant, refused: string): Promise<void> => {
    try {
        await grantMember(grant);
    } catch (err) {
        throw new DaemonRefused(refused, err);
    }
};

const invite = async (value: string, draft: AccessDraft): Promise<boolean> => {
    const id = sandbox.activeSandboxId.value;
    if (id === undefined || busy.value || !sendable(draft)) {
        return false;
    }
    clearNotice();
    const outcome = await writes.run({
        what: t(`sandbox.sandboxAccess.invitingWhom`, { email: value }),
        failed: refusedAs(t(`sandbox.sandboxAccess.recordingInviteFailed`)),
        // The link mail could not carry is read here or nowhere.
        keep: true,
        task: async () => {
            await grantOnDaemon(draftGrant(value, draft), t(`sandbox.sandboxAccess.couldntGrantAccess`));
            const result = await apiClient.invite.create({ sandboxId: id, email: value, role: draft.role });
            return { members: result.members, delivery: result };
        },
    });
    return outcome?.state === `done`;
};

const resend = async (target: string): Promise<void> => {
    const id = sandbox.activeSandboxId.value;
    if (id === undefined || busy.value) {
        return;
    }
    clearNotice();
    const outcome = await writes.run({
        what: t(`sandbox.sandboxAccess.invitingWhom`, { email: target }),
        // Nothing was granted first, so a refusal leaves the roster as it is.
        failed: (error) => ({ notice: noticeFrom(error, t(`sandbox.sandboxAccess.couldntResendInvite`)), reload: false }),
        keep: true,
        task: async () => {
            const result = await apiClient.invite.resend({ sandboxId: id, email: target });
            return { members: result.members, delivery: result };
        },
    });
    // Sent: the page under the dialog is where a link the mail could not carry is said.
    if (outcome?.state === `done`) {
        dialogOpen.value = false;
    }
};

// No device roster can exist: a session is a signed claim the daemon verifies, not stored. The group says what's true:
// this browser, why the rest are unlistable, and the switch's consequence.
const revokingSessions = sessions.busy;
const sessionsRevoked = computed(() => sessions.operation.value?.state === `done`);
// Armed before firing: irreversible, signs out everyone, and can't be aimed at one device.
const confirmingRevoke = ref(false);
const armRevoke = (): void => {
    sessions.dismiss();
    confirmingRevoke.value = true;
};

// A date, not a countdown: the expiry slides forward on renewal, so it reads as neglect risk, not a deadline.
const thisBrowser = computed<string>(() => {
    const who = user.value?.email ?? t(`sandbox.sandboxAccess.youFallback`);
    const expires = sessionExpiresAt.value;
    return expires === undefined
        ? t(`sandbox.sandboxAccess.thisBrowserSignedIn`, { who })
        : t(`sandbox.sandboxAccess.thisBrowserSignedInUntil`, { who, date: formatDate(expires) });
});

const revokeSessions = async (): Promise<void> => {
    if (revokingSessions.value) {
        return;
    }
    localNotice.value = undefined;
    writes.dismiss();
    const outcome = await sessions.run({
        what: t(`sandbox.sandboxAccess.signingOthersOut`),
        failed: t(`sandbox.sandboxAccess.couldntSignOthersOut`),
        // The line under the button says it, where the press was.
        quiet: true,
        task: async () => {
            await sandboxRaw(`POST /system/sessions/revoke`);
        },
    });
    if (outcome?.state === `done`) {
        confirmingRevoke.value = false;
    }
};

// Changes what a person holds with the same two-write, daemon-first order as an invite: the whole grant to the daemon,
// then the tier to the platform's record when it moved. Applies on the member's next request. Reports whether both
// landed, so the dialog closes only on a change that is really made.
const saveAccess = async (target: string, draft: AccessDraft): Promise<boolean> => {
    const id = sandbox.activeSandboxId.value;
    if (id === undefined || busy.value || !sendable(draft)) {
        return false;
    }
    clearNotice();
    if (fencesUnknown.value) {
        localNotice.value = grantsUnread.value;
        return false;
    }
    const recorded = members.value.find((member) => member.email === target)?.role;
    const outcome = await writes.run({
        what: t(`sandbox.sandboxAccess.changingAccessOf`, { email: target }),
        failed: refusedAs(t(`sandbox.sandboxAccess.recordingRoleFailed`)),
        // Quiet: the row's own line is the answer.
        quiet: true,
        task: async () => {
            // Same split as the invite: only the first of the two writes can be a sandbox that isn't answering.
            await grantOnDaemon(draftGrant(target, draft), t(`sandbox.sandboxAccess.couldntChangeRole`));
            if (recorded === draft.role) {
                return {};
            }
            const result = await apiClient.invite.setRole({ sandboxId: id, email: target, role: draft.role });
            return { members: result.members };
        },
    });
    return outcome?.state === `done`;
};

const openAdd = (): void => {
    clearNotice();
    editingEmail.value = undefined;
    dialogOpen.value = true;
};

const openEdit = (member: InviteRecord): void => {
    clearNotice();
    editingEmail.value = member.email;
    dialogOpen.value = true;
};

// The dialog's commit: an invite for a new address, the whole grant for somebody already here.
const saveFromDialog = async (address: string, draft: AccessDraft): Promise<void> => {
    const done = editing.value === undefined ? await invite(address, draft) : await saveAccess(address, draft);
    if (done) {
        dialogOpen.value = false;
    }
};

const revoke = async (target: string): Promise<void> => {
    const id = sandbox.activeSandboxId.value;
    if (id === undefined || busy.value) {
        return;
    }
    clearNotice();
    // Quiet: the row going away is the answer.
    const outcome = await writes.run({
        what: t(`sandbox.sandboxAccess.revokingWhom`, { email: target }),
        failed: refusedAs(t(`sandbox.sandboxAccess.clearingRecordFailed`)),
        quiet: true,
        task: async () => {
            // Enforcer drops access first; a rejecting/offline daemon errors instead of leaving access standing.
            try {
                await revokeMember(target);
            } catch (err) {
                throw new DaemonRefused(t(`sandbox.sandboxAccess.couldntRevokeAccess`), err);
            }
            const result = await apiClient.invite.revoke({ sandboxId: id, email: target });
            return { members: result.members };
        },
    });
    if (outcome?.state === `done`) {
        dialogOpen.value = false;
    }
};
</script>

<template>
    <div class="flex flex-col gap-6">
        <!-- WHO HAS ACCESS: one row per person saying in a line where they work and what their assistants may use, and one
             press to change it. Every decision about a person is made in the dialog, never as a control on the row: five
             controls a row were five half-decisions a re-grade could leave a person stranded between. -->
        <div class="flex flex-col gap-2.5">
            <Notice v-if="grantsUnread && isOwner" :of="grantsUnread" />
            <!-- A link the mail could not carry rides in the slot, so a long one can wrap. -->
            <Notice v-if="notice && !dialogOpen" :of="notice">
                <span v-if="handover" class="mt-1 block break-all font-medium">{{ handover }}</span>
            </Notice>
            <RowGroup :label="t(`sandbox.sandboxAccess.people`)">
                <template v-if="isOwner" #actions>
                    <Button :label="t(`sandbox.sandboxAccess.addPerson`)" size="small" :disabled="busy" @click="openAdd">
                        <template #icon><Icon name="plus" /></template>
                    </Button>
                </template>
                <template v-if="isOwner">
                    <Row :title="user?.email" :description="t(`sandbox.sandboxAccess.lineOwner`)">
                        <template #lead="{ mark }">
                            <Avatar :size="mark" :name="user?.name ?? user?.email ?? ``" :src="user?.image ?? undefined" :hue="identityHue(user?.email ?? ``)" />
                        </template>
                        <template #meta><StatusBadge variant="primary" :label="t(`sandbox.sandboxAccess.owner`)" size="xs" /></template>
                    </Row>
                    <div v-if="listing" role="status" aria-busy="true">
                        <template v-if="outline">
                            <span class="sr-only">{{ t(`sandbox.sandboxAccess.readingWhoAccess`) }}</span>
                            <SkeletonRows :rows="2" control />
                        </template>
                    </div>
                    <Row v-for="member in members" :key="member.email" :title="member.email" :description="accessLine(member)">
                        <template #lead="{ mark }">
                            <Avatar :size="mark" :name="member.email" :hue="identityHue(member.email)" />
                        </template>
                        <!-- The tier first, then where the invite stands; an accepted invite is the ordinary case and says nothing. -->
                        <template #meta>
                            <StatusBadge variant="neutral" :label="roleLabel(grantOf(member.email)?.role ?? member.role)" size="xs" />
                            <StatusBadge
                                v-if="member.status !== `accepted`"
                                :variant="statusOf(member.status).variant"
                                :label="statusOf(member.status).label"
                                :dot="statusOf(member.status).dot"
                                size="xs"
                            />
                        </template>
                        <template #control>
                            <Button
                                :label="t(`ui.action.edit`)"
                                size="small"
                                tier="quiet"
                                :disabled="busy || fencesUnknown"
                                :aria-label="t(`sandbox.sandboxAccess.editAccessOf`, { email: member.email })"
                                @click="openEdit(member)"
                            >
                                <template #icon><Icon name="pencil" /></template>
                            </Button>
                        </template>
                    </Row>
                    <RowNote v-if="!listing && members.length === 0" variant="empty">{{ t(`sandbox.sandboxAccess.onlyYouSoFar`) }}</RowNote>
                </template>

                <template v-else>
                    <Row :title="user?.email">
                        <template #lead="{ mark }">
                            <Avatar :size="mark" :name="user?.name ?? user?.email ?? ``" :src="user?.image ?? undefined" :hue="identityHue(user?.email ?? ``)" />
                        </template>
                        <template #meta>
                            <StatusBadge variant="primary" :label="ownRole" size="xs" />
                            <StatusBadge variant="neutral" :label="t(`sandbox.sandboxAccess.you`)" size="xs" />
                        </template>
                    </Row>
                    <RowNote>{{ t(`sandbox.sandboxAccess.onlySandboxOwnerInvite`) }}</RowNote>
                </template>
            </RowGroup>
        </div>

        <PersonAccessDialog
            v-if="isOwner"
            v-model:open="dialogOpen"
            :editing="editing"
            :initial="initialDraft"
            :busy="busy"
            :notice="notice"
            @save="saveFromDialog"
            @remove="revoke"
            @resend="resend"
        />

        <!-- How people prove themselves to this sandbox, before what programs hold. -->
        <PasskeysSection />

        <!-- Program credentials follow people and include every sandbox token. -->
        <ControlTokensSection />

        <!-- Credential revocation answers whether any access remains active. -->
        <RowGroup v-if="canShip" :label="t(`sandbox.sandboxAccess.signedInBrowsers`)">
            <!-- The one signed-in browser the app can name, because it is running in it. -->
            <Row icon="desktop" :title="t(`sandbox.sandboxAccess.browser`)" :description="thisBrowser">
                <template #meta><StatusBadge variant="success" :label="t(`sandbox.sandboxAccess.signedIn`)" size="xs" /></template>
            </Row>

            <Row icon="sign-out" tone="danger" :title="t(`sandbox.sandboxAccess.signOutEverywhere`)">
                <template #description>{{ t(`sandbox.sandboxAccess.revokesEveryPassStay`) }}</template>
                <template #control>
                    <!-- Clears the last run's receipt; the row says one thing at a time, not a stale result under a live confirm. -->
                    <Button
                        v-if="!confirmingRevoke"
                        :label="t(`sandbox.sandboxAccess.signOutAllBrowsers`)"
                        tone="danger"
                        size="small"
                        :disabled="revokingSessions"
                        @click="armRevoke"
                    >
                        <template #icon><Icon name="sign-out" /></template>
                    </Button>
                </template>
                <template v-if="confirmingRevoke || sessionsRevoked" #below>
                    <div v-if="confirmingRevoke" class="flex flex-wrap items-center justify-end gap-2">
                        <span class="mr-auto text-2xs text-subtle">{{ t(`sandbox.sandboxAccess.sureEveryoneWorkingIn`) }}</span>
                        <Button
                            :label="t(`ui.action.cancel`)"
                            tier="quiet"
                            size="small"
                            :disabled="revokingSessions"
                            @click="confirmingRevoke = false"
                        />
                        <Button
                            :label="t(`sandbox.sandboxAccess.signOutAllBrowsers`)"
                            tone="danger"
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
        <template v-if="canShip">
            <!-- The whole group stands in, drawn as it last looked in this sandbox: its rows sit straight in it. -->
            <SkeletonSnapshot v-if="inventoryLoading" of="sandbox.access.other-ways-in">
                <RowGroup :label="t(`sandbox.sandboxAccess.otherWaysIn`)" equal-rows>
                    <div role="status" aria-busy="true"><SkeletonRows :rows="3" /></div>
                </RowGroup>
            </SkeletonSnapshot>
            <RowGroup
                v-else-if="doors.length > 0"
                v-skeleton-source="`sandbox.access.other-ways-in`"
                :label="t(`sandbox.sandboxAccess.otherWaysIn`)"
                equal-rows
            >
                <Row v-for="door in doors" :key="door.key" :icon="door.icon" :title="door.title" :description="door.description" />
            </RowGroup>
            <!-- What conversations were allowed past their persona or area, each taken back here: the Needs you inbox's Allowed
                 tab until 2026-10-12, now on the page about who and what reaches this box. Draws nothing while nothing stands. -->
            <StandingGrants />
        </template>

        <!-- Live presence: who else is connected right now (everyone sees this). -->
        <RowGroup :label="t(`shared.hereNow`)">
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
