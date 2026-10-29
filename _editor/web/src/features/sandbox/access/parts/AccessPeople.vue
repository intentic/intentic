<script setup lang="ts">
import AccessRequests from "./AccessRequests.vue";
import type { InviteRecord } from "@intentic/api-contract";
import {
    Avatar,
    Await,
    Button,
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
import { computed, ref, useId, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { selfMember, useMembers } from "../../../../client/sandbox/useMembers";
import { useAccess } from "../../../../client/sandbox/access/useAccess";
import { useAuth } from "../../../../client/auth/useAuth";
import { useRole } from "../../../../client/sandbox/useRole";
import { identityHue } from "../../../../lib/identityHue";
import { presenceActivity, presenceOthers } from "../../../../workbench/presence/usePresence";
import AiLiteracySettings from "../../ai-literacy/AiLiteracySettings.vue";
import { type AccessDraft, accessWord, draftOf, newPerson } from "../accessGrant";
import { OPEN_BOUNDS, type PanelBounds, panelBounds, type PeopleManager } from "../person/accessBounds";
import PersonCard from "../PersonCard.vue";
import PersonPanel from "../PersonPanel.vue";
import { useRosterWrites } from "./useRosterWrites";
import { useT } from "@intentic/ui/i18n";

// ACCESS ▸ PEOPLE: who may use this sandbox, what they are told before they start, and who is here now. Whoever manages
// people (the owner, Full access, or someone given People & access) invites and changes access: each write goes to the
// enforced daemon roster first, then the platform record and email, with separate errors (useRosterWrites.ts). Failed
// mail returns the active grant's link. Anyone else sees their own card and who manages people; presence is for everyone.

const t = useT();

const { user } = useAuth();
const access = useAccess();
const self = selfMember();

// The owner's card says so; everyone else's says their tier.
const isOwner = computed(() => access.role.value === `owner`);
// Whether the reader may see and change who has access, as the daemon's floors decide it (sandbox-contract `holdsRight`).
const managesPeople = computed(() => access.holds(`people`));
// Who is editing, as the contract's bound reads them: below Full access, what they may change of each person is bounded
// (person/accessBounds.ts), so the panel offers exactly what the daemon and the platform will take.
const manager = computed((): PeopleManager | undefined => {
    const role = access.role.value;
    return role === undefined ? undefined : { email: user.value?.email ?? ``, role, manages: self.value?.manages };
});
const isMe = (email: string): boolean => email.toLowerCase() === user.value?.email?.toLowerCase();
// Full access and the owner run every control, and set the AI notice.
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
const ownRole = computed((): string => roleLabel(access.role.value ?? `viewer`));

// Whoever manages people reads the daemon's roster through useMembers. Grant/revoke responses update that shared cache,
// so the board's Everyone/Mine row and this tab agree; platform invite records carry only the tier and the rights.
const { roster, members: grants, error: grantsError } = useMembers({ enabled: managesPeople });
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

// What a person's access is as the panel edits it: the daemon's row, or the platform's tier alone for one it never wrote.
const accessOf = (member: InviteRecord): AccessDraft => draftOf(grantOf(member.email), member.role);
// The one word under a person's tile.
const WORDS = {
    manages: () => t(`sandbox.sandboxAccess.wordManages`),
    chats: () => t(`sandbox.sandboxAccess.wordChats`),
    homeOnly: () => t(`sandbox.sandboxAccess.wordHomeOnly`),
    edits: () => t(`sandbox.sandboxAccess.wordEdits`),
    runsAgents: () => t(`sandbox.sandboxAccess.wordRunsAgents`),
    sees: () => t(`sandbox.sandboxAccess.wordSees`),
} as const;
const wordOf = (member: InviteRecord): string => WORDS[accessWord(accessOf(member))]();
// What the reader may change of this person: everything for the owner and Full access.
const boundsOf = (member: InviteRecord): PanelBounds =>
    manager.value === undefined ? OPEN_BOUNDS : panelBounds(manager.value, member.email, grantOf(member.email), member.role);
// The reader's own record, when they are on the roster: their own card opens it.
const ownRecord = computed(() => members.value.find((member) => isMe(member.email)));

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

const { busy, listing, load, notice, panelNotice, handover, clearNotice, invite, resend, savePerson, revoke } = useRosterWrites({
    members,
    fencesUnknown,
    grantsUnread,
    revoked: () => (selected.value = undefined),
});
// The people grid's answer, for whoever manages people: a failed read says so above the grid and leaves it empty.
// Their own record is their own card, first, rather than a tile among the others.
const people = useLoaded(() => ({
    data: listing.value ? undefined : members.value.filter((member) => !isMe(member.email)),
    error: undefined,
    fetching: listing.value && managesPeople.value,
    wanted: managesPeople.value,
}));
// The platform's records are read for whoever manages people, once they are known to (a People & access holder learns
// it from their own answer, a moment after the page opens); anyone else never fetches, and nothing waits on a list
// that never arrives.
watch(
    managesPeople,
    (manages) => {
        if (manages) {
            void load();
            return;
        }
        listing.value = false;
    },
    { immediate: true },
);
</script>

<template>
    <div class="flex flex-col gap-6">
        <!-- What people have asked for, above who they are, at the page's own rhythm: Review opens the person, where a
             grant answers it. -->
        <AccessRequests v-if="managesPeople" @review="(email) => (selected = email)" />
        <!-- WHO HAS ACCESS, as Personas and Models lay theirs out: a tile per person, and the open one's panel under the
             tiles. Adding asks for an address alone; everything else is decided in the panel, which saves as it goes. -->
        <div class="flex flex-col gap-2.5">
            <Notice v-if="grantsUnread && managesPeople" :of="grantsUnread" />
            <!-- A link the mail could not carry rides in the slot, so a long one can wrap. -->
            <Notice v-if="notice && (selectedMember === undefined || handover !== undefined)" :of="notice">
                <span v-if="handover" class="mt-1 block break-all font-medium">{{ handover }}</span>
            </Notice>
            <Section data-setting="access-people" :label="t(`sandbox.sandboxAccess.people`)">
                <!-- Adding someone is the group's own action, top right where every list in the app keeps it; offered once the
                     roster has landed, so the address card it opens lands after the people rather than ahead of them. -->
                <template v-if="managesPeople && !adding" #actions>
                    <Button
                        size="small"
                        tier="boring"
                        :label="t(`sandbox.sandboxAccess.addPerson`)"
                        :disabled="busy || listing"
                        v-tooltip.bottom="t(`sandbox.sandboxAccess.addPersonSub`)"
                        @click="startAdd"
                    >
                        <template #icon><Icon name="plus" /></template>
                    </Button>
                </template>
                <!-- One card per person, the signed-in one first; adding someone grows the group by one card, the address
                     field, at its end. -->
                <div role="group" :aria-label="t(`sandbox.sandboxAccess.people`)" class="grid grid-cols-[repeat(auto-fill,minmax(14rem,1fr))] gap-1">
                    <!-- The reader on the roster opens their own panel from their own card, read-only unless they hold Full
                         access; the owner, who is on no roster, has nothing to open. -->
                    <PersonCard
                        v-if="ownRecord !== undefined && managesPeople"
                        :email="ownRecord.email"
                        :image="user?.image ?? undefined"
                        :line="lineOf(ownRecord)"
                        :selected="selected === ownRecord.email"
                        :aria-controls="panelId"
                        :disabled="fencesUnknown"
                        pressable
                        @press="toggle(ownRecord)"
                    />
                    <PersonCard
                        v-else
                        :email="user?.email ?? ``"
                        :image="user?.image ?? undefined"
                        :line="isOwner ? t(`sandbox.sandboxAccess.wordOwner`) : ownRole"
                    />
                    <!-- While the roster is read, the cells after the owner's own card are drawn as they last looked (one
                         run of grid items imprinted together), else as one person-shaped card. -->
                    <Await v-if="managesPeople" :of="people" imprint="sandbox.access.people" :label="t(`sandbox.sandboxAccess.readingWhoAccess`)">
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
                                    tier="accent"
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
                        </template>
                    </Await>
                </div>
                <RowNote v-if="!managesPeople">{{ t(`sandbox.sandboxAccess.peopleManagedBy`) }}</RowNote>

                <div :id="panelId" class="mt-4">
                    <PersonPanel
                        v-if="managesPeople && selectedMember !== undefined && !fencesUnknown"
                        :key="selectedMember.email"
                        :email="selectedMember.email"
                        :pending="selectedMember.status !== `accepted`"
                        :initial="accessOf(selectedMember)"
                        :busy="busy"
                        :notice="panelNotice"
                        :bounds="boundsOf(selectedMember)"
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
