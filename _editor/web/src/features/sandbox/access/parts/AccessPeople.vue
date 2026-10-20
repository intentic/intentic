<script setup lang="ts">
import type { InviteDelivery, InviteRecord } from "@intentic/api-contract";
import type { MemberGrant } from "@intentic/sandbox-contract/schemas/members";
import {
    Avatar,
    Await,
    Button,
    clipboardOf,
    Notice,
    type NoticeModel,
    Row,
    RowGroup,
    RowNote,
    Section,
    StatusBadge,
} from "@intentic/ui";
import { useLoaded } from "@intentic/extension-api";
import { noticeFrom } from "@intentic/ui/async";
import { computed, onMounted, ref, useId, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { apiClient } from "../../../../lib/useApi";
import { grantMember, revokeMember, useMembers } from "../../../../client/sandbox/useMembers";
import { useAuth } from "../../../../client/auth/useAuth";
import { useSandbox } from "../../../../client/sandbox/useSandbox";
import { useRole } from "../../../../client/sandbox/useRole";
import { identityHue } from "../../../../lib/identityHue";
import { presenceActivity, presenceOthers } from "../../../../workbench/presence/usePresence";
import AiLiteracySettings from "../../ai-literacy/AiLiteracySettings.vue";
import { type AccessDraft, accessWord, draftGrant, draftOf, draftProblem, newPerson } from "../accessGrant";
import { usePersonaReach } from "../usePersonaReach";
import PersonCard from "../PersonCard.vue";
import PersonPanel from "../PersonPanel.vue";
import { type RunOptions, useOperation } from "../../../../workbench/operations/operations";
import { useT } from "@intentic/ui/i18n";

// ACCESS ▸ PEOPLE: who may use this sandbox, what they are told before they start, and who is here now. Owner invites
// write the enforced daemon roster first, then the platform record and email, with separate errors. Failed mail returns
// the active grant's link. Members get read-only access; presence is for everyone.

const t = useT();

const { user } = useAuth();
const sandbox = useSandbox();

const isOwner = computed(() => sandbox.active.value?.role === `owner`);
// Maintainers may operate every control except the roster (`isOwner`), and set the AI notice.
const { canShip } = useRole();

// The platform's invite records: who was invited and how that stands. The daemon's own roster is `grants` below.
const members = ref<InviteRecord[]>([]);

// A person a link names (`?open=<email>`), handed down by the hub so a reload lands on them.
const { open = undefined } = defineProps<{ open?: string }>();

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
// The reader's own tier, for the tile a member sees of themselves.
const ownRole = computed((): string => roleLabel(sandbox.active.value?.role ?? `viewer`));

// The owner reads the daemon's roster through useMembers. Grant/revoke responses update that shared cache,
// so the board's Everyone/Mine row and this tab agree; platform invite records carry only the tier.
const { roster, members: grants, error: grantsError } = useMembers({ enabled: isOwner });
// Block panels while the roster is unreadable: saving a whole grant with unknown fields could widen access.
const grantsUnread = computed<NoticeModel | undefined>(() =>
    grantsError.value === undefined
        ? undefined
        : noticeFrom(new Error(grantsError.value), t(`sandbox.sandboxAccess.couldntReadMemberAreas`), { tone: `warning` }),
);
// Whether access is not known: the roster could not be read, or has not been (a sandbox that is not answering never
// starts the read). No panel opens then, for the same reason.
const fencesUnknown = computed(() => grantsUnread.value !== undefined || roster.value === undefined);
const grantOf = (address: string) => grants.value.find((grant) => grant.email === address.toLowerCase());
// Which assistants a fence hands over: derived from where each card works, never picked per person.
const { namesOf } = usePersonaReach();

// What a person's access is as the panel edits it: the daemon's row, or the platform's tier alone for one it never wrote.
const accessOf = (member: InviteRecord): AccessDraft => draftOf(grantOf(member.email), member.role);
// The one word under a person's tile.
const WORDS = {
    manages: () => t(`sandbox.sandboxAccess.wordManages`),
    chats: () => t(`sandbox.sandboxAccess.wordChats`),
    edits: () => t(`sandbox.sandboxAccess.wordEdits`),
    runsAgents: () => t(`sandbox.sandboxAccess.wordRunsAgents`),
    sees: () => t(`sandbox.sandboxAccess.wordSees`),
} as const;
const wordOf = (member: InviteRecord): string => WORDS[accessWord(accessOf(member))]();

// One person opens beneath the tiles; adding someone opens their setup, with their address in the URL.
const selected = ref<string>();
const selectedMember = computed(() => members.value.find((member) => member.email === selected.value));
const panelId = useId();
const toggle = (member: InviteRecord): void => {
    clearNotice();
    selected.value = selected.value === member.email ? undefined : member.email;
};
const route = useRoute();
const router = useRouter();
// Lands on the person a link names once the roster holds them, once per naming: a refetch must not reopen one the
// owner just closed.
let landedOn: string | undefined;
watch(
    [() => open, members],
    ([asked]) => {
        if (asked === undefined || landedOn === asked || !members.value.some((member) => member.email === asked)) {
            return;
        }
        landedOn = asked;
        selected.value = asked;
    },
    { immediate: true },
);
watch(selected, (email) => {
    if (email !== open) {
        void router.replace({ query: { ...route.query, open: email } });
    }
});

// Adding an address immediately sends a view-only invite, with no agents or spending authority.
// Further access is granted through the person's panel.
const adding = ref(false);
const newEmail = ref(``);
const validEmail = (value: string): boolean => /^[^@\s]+@[^@\s]+\.[^@\s]+$/.test(value);
const newAddress = computed(() => newEmail.value.trim().toLowerCase());
const newTaken = computed(
    () => members.value.some((member) => member.email === newAddress.value) || newAddress.value === user.value?.email?.toLowerCase(),
);
// Said only once there is something to say it about: an address already here at once, one that is not an address only
// after Enter was pressed on it, since a half-typed one is the next keystroke rather than a mistake.
const addTried = ref(false);
const addError = computed((): string | undefined => {
    if (newTaken.value) {
        return t(`sandbox.sandboxAccess.alreadyHasAccess`);
    }
    return addTried.value && !validEmail(newAddress.value) ? t(`sandbox.sandboxAccess.enterValidEmailAddress`) : undefined;
});
const startAdd = (): void => {
    clearNotice();
    selected.value = undefined;
    newEmail.value = ``;
    addTried.value = false;
    adding.value = true;
};
const cancelAdd = (): void => {
    adding.value = false;
    newEmail.value = ``;
};
const addPerson = async (): Promise<void> => {
    addTried.value = true;
    if (!validEmail(newAddress.value) || newTaken.value) {
        return;
    }
    const address = newAddress.value;
    if (await invite(address, newPerson(address))) {
        cancelAdd();
        selected.value = address;
    }
};

// The line under a person's address: what they can do, and where their invite stands while it is not yet taken.
const lineOf = (member: InviteRecord): string => {
    if (member.status === `accepted`) {
        return wordOf(member);
    }
    return `${wordOf(member)} · ${member.status === `expired` ? t(`sandbox.sandboxAccess.inviteExpired`) : t(`sandbox.sandboxAccess.invitePending`)}`;
};

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
// The daemon's refusal, the first of the two writes: nothing changed, and it carries its own sentence, with what the
// daemon said as its cause.
class DaemonRefused extends Error {
    constructor(
        readonly sentence: string,
        options: ErrorOptions,
    ) {
        super(sentence, options);
    }
}
// What a roster write's refusal becomes, typed by the ledger's own option so the thrown value stays the ledger's to name.
type RosterFailed = Extract<RunOptions<RosterWrite, RosterRefusal>[`failed`], (...args: never[]) => RosterRefusal>;
const refusedAs =
    (recording: string): RosterFailed =>
    (error) =>
        error instanceof DaemonRefused
            ? { notice: noticeFrom(error.cause, error.sentence), reload: false }
            : { notice: noticeFrom(error, recording), reload: true };
const writes = useOperation<RosterWrite, RosterRefusal>(`access/members/write`);
const busy = writes.busy;

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
                  // allow(silent-catch): the link is printed whole beside the press, so a refused clipboard leaves it there to copy by hand.
                  run: () => void Promise.resolve(clipboardOf(document.activeElement)?.writeText(result.link)).catch(() => undefined),
              },
          };
});
// The one thing this tab has to say right now: a failure, or an invite whose link the owner must carry.
const notice = computed(() => localNotice.value ?? writes.failure.value?.notice ?? deliveryNotice.value);
// What the open panel says: a write it made that was refused, or a roster it cannot trust. A link to carry is the page's.
const panelNotice = computed(() => localNotice.value ?? writes.failure.value?.notice);
// Accept link the owner carries when mail didn't; beside `notice`, not inside it, since a link is markup.
const handover = computed(() => (notice.value !== undefined && notice.value === deliveryNotice.value ? undelivered.value?.link : undefined));

// Clear the notice and its invite link together before the next write.
const clearNotice = (): void => {
    localNotice.value = undefined;
    writes.dismiss();
};

// True until the mount fetch lands; every later refresh rides a write's own response, never blank again.
const listing = ref(true);
// The people grid's answer, owner-only: a failed read says so above the grid (`localNotice`) and leaves it empty.
const people = useLoaded(() => ({
    data: listing.value ? undefined : members.value,
    error: undefined,
    fetching: listing.value && isOwner.value,
    wanted: isOwner.value,
}));

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

// Invite list is owner-only (the API 403s a member); load only when the viewer owns this sandbox.
onMounted(() => {
    if (isOwner.value) {
        void load();
        return;
    }
    // A member never fetches; leaving `listing` true would wait for a list that never arrives.
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
        throw new DaemonRefused(refused, { cause: err });
    }
};

const invite = async (value: string, draft: AccessDraft): Promise<boolean> => {
    const id = sandbox.activeSandboxId.value;
    if (id === undefined || busy.value || draftProblem(draft, namesOf(draft.see).length) !== undefined) {
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
            const result = await apiClient.invite.create({ sandboxId: id, email: value, role: draftGrant(value, draft).role });
            return { members: result.members, delivery: result };
        },
    });
    return outcome?.state === `done`;
};

const resend = async (target: string): Promise<boolean> => {
    const id = sandbox.activeSandboxId.value;
    if (id === undefined || busy.value) {
        return false;
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
    // Sent: a link the mail could not carry is said above the tiles, with the panel left open.
    return outcome?.state === `done`;
};

// Changes what a person holds with the same two-write, daemon-first order as an invite: the whole grant to the daemon,
// then the tier to the platform's record when it moved. Applies on the person's next request.
const saveAccess = async (target: string, draft: AccessDraft): Promise<boolean> => {
    const id = sandbox.activeSandboxId.value;
    if (id === undefined || draftProblem(draft, namesOf(draft.see).length) !== undefined) {
        return false;
    }
    clearNotice();
    if (fencesUnknown.value) {
        localNotice.value = grantsUnread.value;
        return false;
    }
    const grant = draftGrant(target, draft);
    const recorded = members.value.find((member) => member.email === target)?.role;
    const outcome = await writes.run({
        what: t(`sandbox.sandboxAccess.changingAccessOf`, { email: target }),
        failed: refusedAs(t(`sandbox.sandboxAccess.recordingRoleFailed`)),
        // Quiet: the panel's own Saved is the answer.
        quiet: true,
        task: async () => {
            // Same split as the invite: only the first of the two writes can be a sandbox that isn't answering.
            await grantOnDaemon(grant, t(`sandbox.sandboxAccess.couldntChangeRole`));
            if (recorded === grant.role) {
                return {};
            }
            const result = await apiClient.invite.setRole({ sandboxId: id, email: target, role: grant.role });
            return { members: result.members };
        },
    });
    return outcome?.state === `done`;
};

// The panel saves as it goes, and a write is one at a time: a change made while one is on its way waits behind it
// rather than being dropped, and only the newest change per person is sent once its turn comes.
let queue: Promise<unknown> = Promise.resolve();
const latest = new Map<string, AccessDraft>();
const savePerson = (target: string, draft: AccessDraft): void => {
    latest.set(target, draft);
    queue = queue.then(async () => {
        const next = latest.get(target);
        if (next === undefined) {
            return;
        }
        latest.delete(target);
        await saveAccess(target, next);
    });
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
                throw new DaemonRefused(t(`sandbox.sandboxAccess.couldntRevokeAccess`), { cause: err });
            }
            const result = await apiClient.invite.revoke({ sandboxId: id, email: target });
            return { members: result.members };
        },
    });
    if (outcome?.state === `done`) {
        selected.value = undefined;
    }
};
</script>

<template>
    <div class="flex flex-col gap-6">
        <!-- WHO HAS ACCESS, as Personas and Models lay theirs out: a tile per person, and the open one's panel under the
             tiles. Adding asks for an address alone; everything else is decided in the panel, which saves as it goes. -->
        <div class="flex flex-col gap-2.5">
            <Notice v-if="grantsUnread && isOwner" :of="grantsUnread" />
            <!-- A link the mail could not carry rides in the slot, so a long one can wrap. -->
            <Notice v-if="notice && (selectedMember === undefined || handover !== undefined)" :of="notice">
                <span v-if="handover" class="mt-1 block break-all font-medium">{{ handover }}</span>
            </Notice>
            <Section data-setting="access-people" :label="t(`sandbox.sandboxAccess.people`)">
                <!-- One card per person, the signed-in one first, and the next card is where a new one is added: pressed, it
                     becomes the address field in place, so adding someone grows the group by one card and moves nothing. -->
                <div role="group" :aria-label="t(`sandbox.sandboxAccess.people`)" class="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-1">
                    <PersonCard
                        :email="user?.email ?? ``"
                        :image="user?.image ?? undefined"
                        :line="isOwner ? t(`sandbox.sandboxAccess.wordOwner`) : ownRole"
                    />
                    <!-- While the roster is read, the cells after the owner's own card are drawn as they last looked (the
                         people and the add tile, one run of grid items imprinted together), else as one person-shaped
                         card; the add tile comes with the list, so it lands in its place instead of arriving early and
                         being pushed along by the people that load ahead of it. -->
                    <Await v-if="isOwner" :of="people" imprint="sandbox.access.people" :label="t(`sandbox.sandboxAccess.readingWhoAccess`)">
                        <template #fallback>
                            <div role="status" aria-busy="true" class="flex min-w-0 items-center gap-3 rounded-xl px-3 py-2.5">
                                <span class="sr-only">{{ t(`sandbox.sandboxAccess.readingWhoAccess`) }}</span>
                                <span class="skeleton block size-8 shrink-0 rounded-full" aria-hidden="true" />
                                <span class="flex min-w-0 flex-1 flex-col gap-1.5" aria-hidden="true">
                                    <span class="skeleton block h-3.5 w-32 max-w-full" />
                                    <span class="skeleton block h-2.5 w-16 max-w-full" />
                                </span>
                            </div>
                        </template>
                        <template #default="{ data: invited }">
                            <PersonCard
                                v-for="member in invited"
                                :key="member.email"
                                :email="member.email"
                                :line="lineOf(member)"
                                :dot="member.status === `accepted` ? undefined : member.status === `expired` ? `danger` : `info`"
                                :selected="selected === member.email"
                                :aria-controls="panelId"
                                :disabled="fencesUnknown"
                                pressable
                                @press="toggle(member)"
                            />
                            <form
                                v-if="adding"
                                class="ui-field-shell flex min-w-0 items-center gap-3 rounded-xl px-3 py-2"
                                :class="{ 'ui-field-error-box': addError !== undefined }"
                                @submit.prevent="addPerson"
                            >
                                <Avatar :size="32" :name="newAddress === `` ? `?` : newAddress" :hue="identityHue(newAddress)" class="shrink-0" />
                                <span class="flex min-w-0 flex-1 flex-col">
                                    <input
                                        v-model="newEmail"
                                        type="email"
                                        autocomplete="off"
                                        autofocus
                                        placeholder="name@example.com"
                                        :aria-label="t(`sandbox.sandboxAccess.emailLabel`)"
                                        class="field-bare w-full min-w-0"
                                        @keydown.esc.prevent="cancelAdd"
                                        @blur="newEmail.trim() === `` && cancelAdd()"
                                    />
                                    <span class="truncate text-xs" :class="addError === undefined ? `text-subtle` : `text-danger`">{{
                                        addError ?? t(`sandbox.sandboxAccess.addPersonKeys`)
                                    }}</span>
                                </span>
                                <Button
                                    type="submit"
                                    size="small"
                                    :loading="busy"
                                    :disabled="busy || newTaken || newAddress === ``"
                                    :aria-label="t(`ui.action.add`)"
                                    @mousedown.prevent
                                >
                                    <template #icon><Icon name="check" /></template>
                                </Button>
                            </form>
                            <button
                                v-else
                                type="button"
                                class="ui-row-select flex min-w-0 items-center gap-3 rounded-xl border border-dashed border-line px-3 py-2.5 text-left"
                                :disabled="busy"
                                @click="startAdd"
                            >
                                <span class="flex size-8 shrink-0 items-center justify-center rounded-full text-muted"><Icon name="plus" /></span>
                                <span class="flex min-w-0 flex-col">
                                    <span class="text-sm font-medium text-content">{{ t(`sandbox.sandboxAccess.addPerson`) }}</span>
                                    <span class="truncate text-xs text-subtle">{{ t(`sandbox.sandboxAccess.addPersonSub`) }}</span>
                                </span>
                            </button>
                        </template>
                    </Await>
                </div>
                <RowNote v-if="!isOwner">{{ t(`sandbox.sandboxAccess.onlySandboxOwnerInvite`) }}</RowNote>

                <div :id="panelId" class="mt-4">
                    <PersonPanel
                        v-if="isOwner && selectedMember !== undefined && !fencesUnknown"
                        :key="selectedMember.email"
                        :email="selectedMember.email"
                        :pending="selectedMember.status !== `accepted`"
                        :initial="accessOf(selectedMember)"
                        :busy="busy"
                        :notice="panelNotice"
                        @save="savePerson"
                        @remove="revoke"
                        @resend="resend"
                    />
                </div>
            </Section>
        </div>

        <!-- Live presence: who else is connected right now (everyone sees this). Drawn only while somebody is: an empty
             card saying nobody is here was the tallest thing on a one-person sandbox's page. -->
        <RowGroup v-if="presenceOthers.length > 0" :label="t(`shared.hereNow`)">
            <template v-if="presenceOthers.length > 0">
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
        <!-- What everyone let in is told, beside who they are: the AI notice they confirm before they start. Maintainer and
             up, as the daemon lists the confirmations and takes the setting from no one below. On Agent ▸ Safety until
             2026-10-13, where it is not about the agent; the product analytics switch beside it went to Privacy shield on
             2026-10-16, being data that leaves the box rather than words people read. -->
        <RowGroup v-if="canShip" data-setting="access-ai-notice" :label="t(`sandbox.sandboxAccess.aiNotice`)">
            <AiLiteracySettings />
        </RowGroup>

    </div>
</template>
