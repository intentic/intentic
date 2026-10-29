<script setup lang="ts">
import { profileAccess } from "@intentic/sandbox-contract/schemas/access-profiles";
import ProfileAnswers from "./profiles/ProfileAnswers.vue";
import { useAccessProfiles } from "./profiles/useAccessProfiles";
import type { AgentAccess } from "@intentic/sandbox-contract/schemas/members";
import { Button, Notice, type NoticeModel, Picker, Section, SegmentedControl } from "@intentic/ui";
import ToggleSwitch from "primevue/toggleswitch";
import { computed, onBeforeUnmount, ref, useId, watch } from "vue";
import { type AccessDraft, draftGrant, draftProblem, drivesAgents, rightsFor } from "./accessGrant";
import { OPEN_BOUNDS, type PanelBounds } from "./person/accessBounds";
import PersonRights from "./person/PersonRights.vue";
import AiAccountsPicker from "./ai-accounts/AiAccountsPicker.vue";
import AreaPicker from "./AreaPicker.vue";
import EditPicker from "./EditPicker.vue";
import PersonCard from "./PersonCard.vue";
import ReachPicker from "./ReachPicker.vue";
import { usePersonaReach } from "./usePersonaReach";
import { useT } from "@intentic/ui/i18n";

// ONE PERSON'S ACCESS, opened under their tile: first whether they manage the sandbox (full access, every answer below at
// once), else whether their conversations run agents, where they see and where they edit by hand; then, either way,
// which AI accounts their turns run on and what their agents may spend; and how they sign in. Changes save as they are
// made, like a persona's: a run of clicks is one write, and an answer the daemon would refuse (a chat with no area, a
// narrowed scope with nothing ticked) waits here, said, instead of being sent. Mounted once per person, so a draft never
// carries from one to the next; one still waiting when the panel closes is sent on its way out.
// Under custom access, the parts of the sandbox they may also run come last (PersonRights). Someone given People &
// access edits within `bounds` (person/accessBounds.ts): their own panel and a Full access person's are drawn whole but
// read-only, saying who changes them, and Full access and the rights they lack cannot be picked.

const t = useT();

const {
    email,
    pending,
    initial,
    busy = false,
    notice,
    bounds = OPEN_BOUNDS,
} = defineProps<{
    email: string;
    // Whether their invite is still out, for the line under the address and its Resend.
    pending: boolean;
    // What the daemon holds for them, read once when the panel opens.
    initial: AccessDraft;
    busy?: boolean;
    notice?: NoticeModel | undefined;
    // What the person editing may change here; the owner and Full access may change everything.
    bounds?: PanelBounds;
}>();
const emit = defineEmits<{ save: [email: string, draft: AccessDraft]; remove: [email: string]; resend: [email: string] }>();

const draft = ref<AccessDraft>(initial);
const { available: profilesAvailable, profiles } = useAccessProfiles();
const profileOptions = computed(() => [{ value: ``, label: t(`sandbox.accessProfiles.ownAnswers`) }, ...profiles.value.map((profile) => ({ value: profile.id, label: profile.label ?? profile.id }))]);
const chosenProfile = computed(() => profiles.value.find((profile) => profile.id === draft.value.profile));
const ownAnswers = ref<AccessDraft>(initial);
const chooseProfile = (id: string | undefined): void => {
    const profile = profiles.value.find((entry) => entry.id === id);
    // Rights ride beside a profile, never in one, so picking or leaving one keeps the ones its way of working can carry.
    const { emailSignIn, manages } = draft.value;
    if (profile === undefined) {
        draft.value = { ...ownAnswers.value, profile: undefined, emailSignIn, manages: rightsFor(ownAnswers.value.agents, manages) };
        return;
    }
    if (draft.value.profile === undefined) { ownAnswers.value = draft.value; }
    const access = profileAccess(profile);
    draft.value = { ...access, profile: profile.id, tools: profile.tools, assistants: profile.assistants, credentials: profile.credentials ?? `all`, aiAccounts: profile.aiAccounts ?? `all`, emailSignIn, manages: rightsFor(access.agents, manages) };
};
const set = (change: Partial<AccessDraft>): void => {
    draft.value = { ...draft.value, ...change };
};

const { namesOf } = usePersonaReach();
const problem = computed(() => draftProblem(draft.value, namesOf(draft.value.see).length));
// Whether what is on screen is not yet what the daemon holds, compared as the grant each would send.
const saved = ref(JSON.stringify(draftGrant(email, initial)));
const dirty = computed(() => JSON.stringify(draftGrant(email, draft.value)) !== saved.value);

// Debounced, since several flips or a few ticks are one intent, not one write each.
const DEBOUNCE_MS = 600;
let timer: ReturnType<typeof setTimeout> | undefined;
const flush = (): void => {
    timer = undefined;
    if (problem.value !== undefined || !dirty.value) {
        return;
    }
    saved.value = JSON.stringify(draftGrant(email, draft.value));
    emit(`save`, email, draft.value);
};
watch(draft, () => {
    clearTimeout(timer);
    timer = problem.value === undefined && dirty.value ? setTimeout(flush, DEBOUNCE_MS) : undefined;
});
// A refused save leaves the draft standing as unsaved, so a retry is the next change rather than a lost one.
watch(
    () => notice,
    (now) => {
        if (now !== undefined) {
            saved.value = JSON.stringify(draftGrant(email, initial));
        }
    },
);
onBeforeUnmount(() => {
    if (timer !== undefined) {
        clearTimeout(timer);
        flush();
    }
});

// What the panel says of its own state, beside the address: held back, on its way, or what the daemon holds.
interface SaveStatus {
    readonly text: string;
    readonly tone: `muted` | `success` | `warning`;
}
const status = computed((): SaveStatus => {
    if (problem.value !== undefined || notice !== undefined) {
        return { text: t(`sandbox.sandboxAccess.notSaved`), tone: `warning` };
    }
    if (busy || dirty.value) {
        return { text: t(`sandbox.sandboxAccess.saving`), tone: `muted` };
    }
    return { text: t(`sandbox.sandboxAccess.saved`), tone: `success` };
});

// AGENTS: chatting is the guest's way of working, held to areas; leaving it keeps the areas, and coming to it drops
// hand edits, which a chat never has. Home only is the master view's one conversation and nothing else: no hand edits
// either, its areas optional, and whether its work lands by itself (`lands`) is also whether they may land it.
// What each choice means rides on the choice itself, as a hover card, rather than as a line under the control.
const AGENTS = computed(() => [
    {
        value: `off` as const,
        label: t(`sandbox.sandboxAccess.agentsOff`),
        title: { title: t(`sandbox.sandboxAccess.tipOffTitle`), note: t(`sandbox.sandboxAccess.tipOffNote`) },
    },
    {
        value: `chat` as const,
        label: t(`sandbox.sandboxAccess.agentsChat`),
        title: { title: t(`sandbox.sandboxAccess.tipChatTitle`), note: t(`sandbox.sandboxAccess.tipChatNote`) },
    },
    {
        value: `home` as const,
        label: t(`sandbox.sandboxAccess.agentsHome`),
        title: { title: t(`sandbox.sandboxAccess.tipHomeTitle`), note: t(`sandbox.sandboxAccess.tipHomeNote`) },
    },
    {
        value: `run` as const,
        label: t(`sandbox.sandboxAccess.agentsRun`),
        title: { title: t(`sandbox.sandboxAccess.tipRunTitle`), note: t(`sandbox.sandboxAccess.tipRunNote`) },
    },
]);
// The rights a way of working cannot carry go with the move: none for chatting or home only, no AI accounts of their
// own with agents off.
const pickAgents = (agents: AgentAccess): void => {
    const manages = rightsFor(agents, draft.value.manages);
    if (agents === `chat`) {
        set({ agents, see: draft.value.see ?? [], edit: `none`, manages });
        return;
    }
    set(agents === `home` ? { agents, edit: `none`, manages } : { agents, manages });
};

// SEE: editing never reaches past it, so narrowing what they see narrows what they edit with it.
const pickSee = (see: string[] | undefined): void => {
    const { edit } = draft.value;
    const kept = see === undefined || edit === `none` ? edit : edit === `all` ? [...see] : edit.filter((area) => see.includes(area));
    set({ see, edit: kept });
};

// ACCESS: managing the sandbox is every other answer at once, so it is the first thing asked rather than a switch found
// after the rest has been set up by hand. The answers below are kept while it is on, so turning it off again gives them back;
// a person who managed from the start comes down to running agents across the workspace.
// Coming down with nothing to come back to hands over no rights either: each is a part of the sandbox given on purpose.
// What their conversations spend is not part of managing: the AI accounts and connections picked carry across either way,
// so "full access, but only on these accounts" is one switch away from what was just picked. A reach with nothing picked
// (where a new person starts) is not carried up: nobody choosing full access means "and no connections".
const beforeManage = ref<AccessDraft>();
const pickManage = (on: boolean): void => {
    const { credentials, aiAccounts } = draft.value;
    if (on) {
        beforeManage.value = draft.value;
        const nothing = credentials !== `all` && credentials.capabilities.length === 0 && credentials.secrets.length === 0;
        set({ manage: true, profile: undefined, credentials: nothing ? `all` : credentials });
        return;
    }
    const back = beforeManage.value;
    // A profile's own answers come back whole; answers of their own keep what was picked while they managed.
    const spend = back?.profile === undefined ? { credentials, aiAccounts } : {};
    set(back === undefined ? { manage: false, agents: `run`, see: undefined, edit: `none`, manages: undefined } : { ...back, ...spend, emailSignIn: draft.value.emailSignIn, manage: false });
};

type Level = `custom` | `full`;
const fullHeld = computed(() => bounds.locked === undefined && !bounds.full);
const LEVELS = computed(() => [
    {
        value: `custom` as const,
        label: t(`sandbox.sandboxAccess.accessCustom`),
        title: { title: t(`sandbox.sandboxAccess.tipCustomTitle`), note: t(`sandbox.sandboxAccess.tipCustomNote`) },
    },
    {
        value: `full` as const,
        label: t(`sandbox.sandboxAccess.accessFull`),
        // Not theirs to grant when People & access is all they hold; the hover card says whose it is. A panel read-only
        // whole holds every choice still already, the one picked included, so this one is not dimmed a second time.
        disabled: fullHeld.value,
        title: { title: t(`sandbox.sandboxAccess.tipFullTitle`), note: fullHeld.value ? t(`sandbox.sandboxAccess.tipFullLockedNote`) : t(`sandbox.sandboxAccess.tipFullNote`) },
    },
]);
// Full access said in the same words the custom answers use, so the reader sees what it hands over before picking it:
// every part custom access hands out one at a time, their own access included, and every setting.
// What their conversations spend is not in it: those two are still pickers, asked below it.
const FULL = computed(() => [
    { label: t(`sandbox.sandboxAccess.agentsSection`), value: t(`sandbox.sandboxAccess.fullAgentsValue`) },
    { label: t(`sandbox.sandboxAccess.seeSection`), value: t(`sandbox.sandboxAccess.wholeWorkspace`) },
    { label: t(`sandbox.sandboxAccess.editSection`), value: t(`sandbox.sandboxAccess.editEverything`) },
    { label: t(`sandbox.sandboxAccess.rightsSection`), value: t(`sandbox.sandboxAccess.fullRightsValue`) },
    { label: t(`sandbox.sandboxAccess.fullSettings`), value: t(`sandbox.sandboxAccess.fullSettingsValue`) },
]);
// Read-only for the person editing, and why, in one quiet line: their own access, or a Full access person's.
const locked = computed(() => bounds.locked !== undefined);
const lockLine = computed(() =>
    bounds.locked === undefined ? undefined : bounds.locked === `own` ? t(`sandbox.sandboxAccess.lockedOwn`) : t(`sandbox.sandboxAccess.lockedFull`),
);
// Whether a full-access person is held to some of what the sandbox spends: said once, since a terminal (part of full
// access) still reaches the whole box, and whoever grants it should know the limit is a rule for people they trust.
const fullButLimited = computed(() => draft.value.manage && (draft.value.aiAccounts !== `all` || draft.value.credentials !== `all`));

const PROBLEMS = {
    pickSeeArea: () => t(`sandbox.sandboxAccess.pickSeeArea`),
    pickEditArea: () => t(`sandbox.sandboxAccess.pickEditArea`),
    chatNeedsArea: () => t(`sandbox.sandboxAccess.guestNeedsArea`),
    chatReachesNobody: () => t(`sandbox.sandboxAccess.noAssistantWorksHere`),
    editOutsideSee: () => t(`sandbox.sandboxAccess.editOutsideSee`),
    pickAiAccount: () => t(`sandbox.sandboxAccess.pickAiAccount`),
} as const;

const confirmingRemove = ref(false);
const landsId = useId();
const signInId = useId();
</script>

<template>
    <section class="flex flex-col gap-5 rounded-xl bg-card p-4 shadow-sm md:p-5" :aria-label="email">
        <!-- The person as their card draws them, so a long address gives way the same way here; the presses about them
             (send the invite again, take access away) sit after it and drop under it when the panel is narrow. -->
        <div class="flex flex-wrap items-center gap-x-3 gap-y-2">
            <PersonCard
                :email="email"
                :line="pending ? t(`sandbox.sandboxAccess.invitePending`) : t(`sandbox.sandboxAccess.member`)"
                :avatar="36"
                flush
                class="min-w-48 flex-1"
            />
            <div class="ml-auto flex shrink-0 items-center gap-1">
                <span
                    v-if="bounds.locked === undefined"
                    class="mr-1 flex items-center gap-1 text-xs"
                    :class="{ 'text-success': status.tone === `success`, 'text-warning': status.tone === `warning`, 'text-muted': status.tone === `muted` }"
                    role="status"
                >
                    <Icon v-if="status.tone === `success`" name="check" class="text-2xs" />{{ status.text }}
                </span>
                <template v-if="confirmingRemove">
                    <Button :label="t(`ui.action.cancel`)" size="small" tier="quiet" @click="confirmingRemove = false" />
                    <Button tier="accent" :label="t(`sandbox.sandboxAccess.removeAccess`)" size="small" tone="danger" :loading="busy" @click="emit(`remove`, email)" />
                </template>
                <template v-else>
                    <Button v-if="pending" :label="t(`sandbox.sandboxAccess.resend`)" size="small" tier="quiet" :disabled="busy" @click="emit(`resend`, email)">
                        <template #icon><Icon name="send" /></template>
                    </Button>
                    <Button v-if="bounds.locked === undefined" :label="t(`ui.action.remove`)" size="small" tier="quiet" tone="danger" :disabled="busy" @click="confirmingRemove = true">
                        <template #icon><Icon name="trash" /></template>
                    </Button>
                </template>
            </div>
        </div>

        <Notice v-if="notice" :of="notice" />
        <p v-else-if="problem !== undefined" class="text-xs text-warning">{{ PROBLEMS[problem]() }}</p>
        <p v-if="lockLine" class="text-xs text-muted">{{ lockLine }}</p>

        <!-- Read-only for whoever may not change it: every answer stays drawn, and a disabled fieldset holds every control
             in it still, as an organisation's lock does (OrgHeldSection.vue). -->
        <fieldset :disabled="locked" class="flex min-w-0 flex-col gap-5">
            <Section :label="t(`sandbox.sandboxAccess.accessSection`)">
                <SegmentedControl
                    :model-value="draft.manage ? `full` : `custom`"
                    :options="LEVELS"
                    :class="{ 'opacity-60': locked }"
                    @update:model-value="(level: Level) => pickManage(level === `full`)"
                />
            </Section>

            <Section v-if="profilesAvailable && !draft.manage" :label="t(`sandbox.accessProfiles.title`)">
                <Picker
                    :model-value="draft.profile ?? ``"
                    :options="profileOptions"
                    variant="input"
                    :disabled="locked"
                    :aria-label="t(`sandbox.accessProfiles.title`)"
                    @update:model-value="chooseProfile"
                />
            </Section>
            <ProfileAnswers v-if="chosenProfile && !draft.manage" :profile="chosenProfile" disabled />
            <template v-if="draft.manage">
                <dl class="flex flex-col gap-2">
                    <div v-for="row in FULL" :key="row.label" class="flex flex-col gap-0.5 sm:flex-row sm:gap-3">
                        <dt class="shrink-0 text-xs text-muted sm:w-44 sm:text-sm">{{ row.label }}</dt>
                        <dd class="text-sm text-content">{{ row.value }}</dd>
                    </div>
                </dl>

                <Section :label="t(`sandbox.sandboxAccess.aiAccountsSection`)">
                    <AiAccountsPicker :accounts="draft.aiAccounts" :disabled="locked" @change="(aiAccounts) => set({ aiAccounts })" />
                </Section>

                <Section :label="t(`sandbox.sandboxAccess.reachSection`)">
                    <ReachPicker :reach="draft.credentials" :disabled="locked" @change="(credentials) => set({ credentials })" />
                </Section>

                <p v-if="fullButLimited" class="text-xs text-muted">{{ t(`sandbox.sandboxAccess.fullLimitNote`) }}</p>
            </template>
            <template v-else-if="draft.profile === undefined">
                <Section :label="t(`sandbox.sandboxAccess.agentsSection`)">
                    <div class="flex flex-col gap-2">
                        <SegmentedControl :model-value="draft.agents" :options="AGENTS" :class="{ 'opacity-60': locked }" @update:model-value="pickAgents" />
                        <div v-if="draft.agents === `home`" class="flex items-center gap-3 py-1.5">
                            <label :for="landsId" class="flex min-w-0 flex-1 cursor-pointer flex-col">
                                <span class="text-sm text-content">{{ t(`sandbox.sandboxAccess.homeLands`) }}</span>
                                <span class="text-xs text-muted">{{ t(`sandbox.sandboxAccess.homeLandsNote`) }}</span>
                            </label>
                            <ToggleSwitch
                                :input-id="landsId"
                                :model-value="draft.lands === true"
                                :disabled="locked"
                                class="ui-switch-sm shrink-0"
                                @update:model-value="(lands: boolean) => set({ lands })"
                            />
                        </div>
                    </div>
                </Section>

                <Section :label="t(`sandbox.sandboxAccess.seeSection`)">
                    <AreaPicker :picked="draft.see" :chat="draft.agents === `chat`" :disabled="locked" @change="pickSee" />
                </Section>

                <Section v-if="draft.agents !== `chat` && draft.agents !== `home`" :label="t(`sandbox.sandboxAccess.editSection`)">
                    <EditPicker :edit="draft.edit" :see="draft.see" :disabled="locked" @change="(edit) => set({ edit })" />
                </Section>

                <Section v-if="drivesAgents(draft.agents)" :label="t(`sandbox.sandboxAccess.aiAccountsSection`)">
                    <AiAccountsPicker :accounts="draft.aiAccounts" :disabled="locked" @change="(aiAccounts) => set({ aiAccounts })" />
                </Section>

                <Section v-if="drivesAgents(draft.agents)" :label="t(`sandbox.sandboxAccess.reachSection`)">
                    <ReachPicker :reach="draft.credentials" :disabled="locked" @change="(credentials) => set({ credentials })" />
                </Section>
            </template>

            <!-- Beside their own answers or a profile alike: rights are handed to a person, never through a profile. -->
            <PersonRights
                v-if="!draft.manage"
                :agents="draft.agents"
                :manages="draft.manages"
                :grantable="bounds.rights"
                @change="(manages) => set({ manages })"
            />

            <div class="-mx-1 flex flex-col border-t border-line-subtle pt-3">
                <div class="flex items-center gap-3 px-1 py-1.5">
                    <label :for="signInId" class="flex min-w-0 flex-1 cursor-pointer flex-col">
                        <span class="text-sm text-content">{{ t(`sandbox.sandboxAccess.signInWithCode`) }}</span>
                        <span class="text-xs text-muted">{{ t(`sandbox.sandboxAccess.signInWithCodeNote`) }}</span>
                    </label>
                    <ToggleSwitch
                        :input-id="signInId"
                        :model-value="draft.emailSignIn"
                        :disabled="locked"
                        class="ui-switch-sm shrink-0"
                        @update:model-value="(on: boolean) => set({ emailSignIn: on })"
                    />
                </div>
            </div>
        </fieldset>
    </section>
</template>
