<script setup lang="ts">
import { BrandMark, ui, CopyButton, DisclosureRow, Notice, type NoticeModel, SegmentedControl, StatusBadge, vAction } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { timeAgo } from "@intentic/ui/format";
import { computed, ref, watch } from "vue";
import { RouterLink } from "vue-router";
import type { CredentialGateScope } from "@intentic/sandbox-contract";
import type { SecretRow } from "../../sandbox/secrets/secretRows";
import { reveal, useCredentialGates, useSecrets } from "./useSecrets";
import ToggleSwitch from "primevue/toggleswitch";
import SecretField from "./SecretField.vue";

// One secret, one line, until asked otherwise: a mark, a name, what tells it apart, and (only when owed) a due
// badge. Reveal/copy/set/remove fade in on hover, focus or touch rather than crowding a scanned list. Expansion
// belongs to the parent (one row open at a time); closing drops whatever the row opened with.

const { row, expanded } = defineProps<{ row: SecretRow; expanded: boolean }>();
const emit = defineEmits<{ "update:expanded": [expanded: boolean] }>();

const { remove } = useSecrets();

// Editing a gate is owner-only (enforced by the daemon's route); this renders the read-only view for everyone else.
// The draft stays local until Save, since a gate's three decisions only make sense sent together, and the switch
// reflects the draft rather than only a stored gate.
const { gateFor, approverChoices, isOwner, setGate, removeGate } = useCredentialGates();

const gate = computed(() => (row.gateSubject === undefined ? undefined : gateFor(row.gateSubject)));
const draftOn = ref(false);
const draftApprovers = ref<string[]>([]);
const draftScope = ref<CredentialGateScope>(`use`);
const gateError = ref<NoticeModel | undefined>(undefined);
// On when a gate is stored, or when the owner has opened the editor to write one.
const gateOn = computed(() => gate.value !== undefined || draftOn.value);

// Draft re-syncs to the server's answer whenever the row opens or the policy changes, so a stale draft can't
// overwrite another tab's edit.
watch(
    [() => expanded, gate],
    () => {
        draftOn.value = false;
        draftApprovers.value = [...(gate.value?.approvers ?? [])];
        draftScope.value = gate.value?.scope ?? (row.sessionShaped ? `conversation` : `use`);
        gateError.value = undefined;
    },
    { immediate: true },
);

// Turning on pre-picks the roster's first approver; turning off either removes a stored gate or just discards an
// unsaved draft.
const toggleGate = (on: boolean): void => {
    if (on) {
        draftOn.value = true;
        draftApprovers.value = gate.value === undefined ? approverChoices.value.slice(0, 1) : [...gate.value.approvers];
        draftScope.value = gate.value?.scope ?? (row.sessionShaped ? `conversation` : `use`);
        return;
    }
    if (gate.value !== undefined) {
        void clearGate();
        return;
    }
    draftOn.value = false;
    draftApprovers.value = [];
};

const toggleApprover = (email: string): void => {
    draftApprovers.value = draftApprovers.value.includes(email)
        ? draftApprovers.value.filter((entry) => entry !== email)
        : [...draftApprovers.value, email];
};

// Saveable only with somebody on it and only when something actually changed (the route refuses an empty list).
const gateDirty = computed(
    () =>
        draftApprovers.value.length > 0 &&
        (gate.value === undefined ||
            gate.value.scope !== draftScope.value ||
            gate.value.approvers.length !== draftApprovers.value.length ||
            !gate.value.approvers.every((approver) => draftApprovers.value.includes(approver))),
);

const saveGate = async (): Promise<void> => {
    gateError.value = undefined;
    if (row.gateSubject === undefined) {
        return;
    }
    try {
        await setGate.mutateAsync({
            subject: row.gateSubject,
            kind: row.entry.kind === `capability` ? `capability` : `secret`,
            approvers: draftApprovers.value,
            scope: draftScope.value,
        });
    } catch (err) {
        gateError.value = noticeFrom(err, `Could not save who has to approve this.`);
    }
};

const clearGate = async (): Promise<void> => {
    gateError.value = undefined;
    if (row.gateSubject === undefined) {
        return;
    }
    try {
        await removeGate.mutateAsync(row.gateSubject);
    } catch (err) {
        gateError.value = noticeFrom(err, `Could not stop requiring approval.`);
    }
};

const SCOPE_OPTIONS = [
    { label: `This once`, value: `use` as const, title: `One click releases exactly one use. The next use asks again.` },
    { label: `Rest of the conversation`, value: `conversation` as const, title: `One click covers every use for the rest of that conversation.` },
];

const editing = ref(false);
const multiline = ref(false);
const revealedValue = ref<string | undefined>(undefined);
const confirming = ref(false);
const error = ref<NoticeModel | undefined>(undefined);

const entry = computed(() => row.entry);
// A value exists and this viewer is allowed to read it: gates both Reveal and Copy.
const canReveal = computed(() => entry.value.status !== `missing` && entry.value.revealable);
// What the open panel shows: provenance only, the revealed value, or the editor (reveal ⊕ edit).
const panelMode = computed<`info` | `reveal` | `edit`>(() => (editing.value ? `edit` : revealedValue.value !== undefined ? `reveal` : `info`));
// Nominal is silent: a connection that is simply working says so by carrying nothing.
const state = computed(() => (row.state !== undefined && row.state.rank < 3 ? row.state : undefined));

watch(
    () => expanded,
    (open) => {
        if (open) {
            return;
        }
        editing.value = false;
        revealedValue.value = undefined;
        confirming.value = false;
        error.value = undefined;
    },
);

const open = (): void => emit(`update:expanded`, true);

const toggleReveal = async (): Promise<void> => {
    error.value = undefined;
    if (revealedValue.value !== undefined) {
        revealedValue.value = undefined;
        return;
    }
    editing.value = false;
    open();
    try {
        revealedValue.value = await reveal(entry.value.key);
    } catch (err) {
        error.value = noticeFrom(err, `Could not reveal the value.`);
    }
};

const startEdit = (): void => {
    error.value = undefined;
    revealedValue.value = undefined;
    editing.value = true;
    open();
};

const removeKey = async (): Promise<void> => {
    error.value = undefined;
    try {
        await remove.mutateAsync(entry.value.key);
    } catch (err) {
        confirming.value = false;
        open();
        error.value = noticeFrom(err, `Could not remove the secret.`);
    }
};

// Centres its glyph in a fixed 24px box via flex, matching CopyButton's centring, so icon buttons in one cluster
// don't visually drift apart.
const ACTION = ui.iconButton(`text-subtle disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-subtle`);
</script>

<template>
    <!--
        Header and panel share one tint while open, reading as a single block; the wash, chevron and rail are
        <DisclosureRow>'s. `body="rail"` since what opens is the secret's record.
    -->
    <DisclosureRow class="@container" :open="expanded" @update:open="emit(`update:expanded`, !expanded)">
        <template #lead="{ mark }">
            <!--
                The only non-text element, findable without reading (accounts differing only in a last character).
                Sized by the
                row's tier (from the enclosing <RowGroup>), not fixed here.
            -->
            <BrandMark :size="mark" :name="row.title" :logo="row.logo" :icon="row.icon" />
        </template>

        <template #title>
            <span class="flex min-w-0 items-baseline gap-2.5">
                <span
                    v-tooltip.top.overflow="row.title"
                    class="min-w-0 flex-1 truncate @xl:w-56 @xl:flex-none"
                    :class="row.mono ? `font-mono` : ``"
                    >{{ row.title }}</span
                >
                <!--
                    Dropped rather than wrapped at rail width: the name is what the row is for; the panel below repeats
                    the detail.
                -->
                <span
                    v-if="row.detail"
                    v-tooltip.top.overflow="row.detail"
                    class="hidden min-w-0 flex-1 truncate text-2xs font-normal text-muted @xl:block"
                    >{{ row.detail }}</span
                >
            </span>
        </template>

        <template v-if="row.note && !expanded" #description>
            <span class="block truncate" :class="row.attention ? `text-warning` : `text-subtle`">{{ row.note }}</span>
        </template>

        <template #control>
            <span class="flex shrink-0 items-center gap-1.5">
                <StatusBadge v-if="state" :variant="state.tone" :label="state.label" size="xs" />
                <span
                    class="flex items-center gap-0.5 text-subtle transition-opacity pointer-coarse:opacity-100 group-focus-within:opacity-100 group-hover:opacity-100"
                    :class="expanded || confirming ? `opacity-100` : `opacity-0`"
                >
                    <button
                        v-if="row.entry.status !== `missing`"
                        v-tooltip.top="revealedValue !== undefined ? `Hide` : `Reveal (owner only)`"
                        type="button"
                        :class="ACTION"
                        :disabled="!canReveal"
                        :aria-label="revealedValue !== undefined ? `Hide value` : `Reveal value (owner only)`"
                        v-action="toggleReveal"
                    >
                        <Icon :name="revealedValue !== undefined ? `eye-slash` : `eye`" class="text-xs" />
                    </button>
                    <CopyButton v-if="canReveal" v-tooltip.top="`Copy value`" :text="() => revealedValue ?? reveal(row.entry.key)" />
                    <button
                        v-if="row.editable"
                        v-tooltip.top="`Set / update`"
                        type="button"
                        :class="ACTION"
                        aria-label="Set / update value"
                        @click="startEdit"
                    >
                        <Icon name="pencil" class="text-xs" />
                    </button>
                    <template v-if="row.removable">
                        <button
                            v-if="!confirming"
                            v-tooltip.top="`Remove`"
                            type="button"
                            :class="ACTION"
                            aria-label="Remove"
                            @click="confirming = true"
                        >
                            <Icon name="trash" class="text-xs" />
                        </button>
                        <template v-else>
                            <button
                                v-tooltip.top="`Confirm remove`"
                                type="button"
                                :class="ui.iconButton(`text-danger hover:bg-danger/10 hover:text-danger`)"
                                aria-label="Confirm remove"
                                v-action="removeKey"
                            >
                                <Icon name="check" class="text-xs" />
                            </button>
                            <button v-tooltip.top="`Cancel`" type="button" :class="ACTION" aria-label="Cancel remove" @click="confirming = false">
                                <Icon name="times" class="text-xs" />
                            </button>
                        </template>
                    </template>
                </span>
            </span>
        </template>

        <!-- The full record, one click away: where it lives, what uses it, and either the value or the editor. -->
        <template #below>
            <p class="text-2xs text-muted">
                <template v-if="row.detail">
                    <span class="@xl:hidden">{{ row.detail }} · </span>
                </template>
                <template v-if="row.entry.kind === `generated`">generated for you · </template>lives in
                <span class="font-mono text-subtle">{{ row.entry.storedAt }}</span>
                <template v-if="row.entry.ci !== undefined"> · CI {{ row.entry.ci.synced ? `synced` : `out of date` }}</template>
            </p>
            <!-- Use ledger's newest row: when the agent last spent this and where; absent for a secret never yet used. -->
            <p v-if="row.entry.lastUse" class="pt-0.5 text-2xs text-muted">
                used by the agent {{ timeAgo(row.entry.lastUse.at, { days: true }) }}
                <template v-if="row.entry.lastUse.detail">
                    ·
                    <span v-if="row.entry.lastUse.lane === `browser`">typed on {{ row.entry.lastUse.detail }}</span>
                    <span v-else class="font-mono text-subtle">{{ row.entry.lastUse.detail }}</span>
                </template>
            </p>
            <!--
                Who has to release this: off for nearly everything by design, since gating is for the few credentials
                where one
                wrong use is the incident. Owner-only to change; shown only on rows with something to release.
            -->
            <div v-if="row.gateSubject !== undefined" class="mt-3 border-t border-line pt-2">
                <div class="flex items-center justify-between gap-2">
                    <span class="text-2xs font-medium uppercase tracking-wide text-subtle">Needs approval</span>
                    <ToggleSwitch
                        v-if="isOwner"
                        :model-value="gateOn"
                        v-tooltip.top="
                            gateOn
                                ? `Let the agent use this without asking anybody`
                                : `Require a named person to release this before the agent can use it`
                        "
                        aria-label="Needs approval"
                        @update:model-value="toggleGate"
                    />
                </div>

                <!--
                    Not the owner: states the gate's status and that only the owner can change it, rather than hiding
                    the controls
                    silently.
                -->
                <p v-if="!isOwner" class="pt-0.5 text-2xs text-muted">
                    <template v-if="gate">
                        Only {{ gate.approvers.join(` or `) }} can release this, and
                        {{ gate.scope === `conversation` ? `one release covers the rest of a conversation` : `every use asks again` }}. Only the owner
                        can change this.
                    </template>
                    <template v-else>Nobody has to approve this. Only the owner can change that.</template>
                </p>

                <template v-else-if="gateOn">
                    <!--
                        Approvers are an exact list, not a role floor ("only Bob"); the owner appears here too, since
                        they aren't an
                        implicit approver.
                    -->
                    <p class="pt-1 text-2xs text-muted">Who can release it</p>
                    <div class="flex flex-wrap gap-1 pt-1">
                        <button
                            v-for="email of approverChoices"
                            :key="email"
                            type="button"
                            class="ui-chip py-1 px-2 text-2xs"
                            :class="draftApprovers.includes(email) ? `ui-chip-on` : ``"
                            :aria-pressed="draftApprovers.includes(email)"
                            @click="toggleApprover(email)"
                        >
                            {{ email }}
                        </button>
                    </div>
                    <!--
                        Names come from the Access roster plus the owner; the daemon refuses anyone else. Tells an
                        owner alone on a fresh
                        sandbox that this isn't the whole feature.
                    -->
                    <p v-if="approverChoices.length === 0" class="pt-1 text-2xs text-muted">
                        Nobody can be named yet. Give somebody access on the
                        <RouterLink to="/sandbox/access" class="text-link hover:underline">Access tab</RouterLink> first.
                    </p>
                    <p v-else-if="approverChoices.length === 1" class="pt-1 text-2xs text-muted">
                        Only you so far. Anybody you give access on the
                        <RouterLink to="/sandbox/access" class="text-link hover:underline">Access tab</RouterLink> can be named here.
                    </p>

                    <!--
                        How long one release lasts, except where it isn't a choice: a signed-in profile or running MCP
                        server is mounted
                        for a whole turn, so the daemon forces that scope regardless of the switch.
                    -->
                    <p class="pt-2 text-2xs text-muted">How long one release lasts</p>
                    <p v-if="row.sessionShaped" class="pt-0.5 text-2xs text-subtle">
                        For the rest of the conversation. A signed-in account is loaded for a whole turn, so it cannot be released for a single use.
                    </p>
                    <SegmentedControl v-else v-model="draftScope" :options="SCOPE_OPTIONS" size="xs" wrap class="pt-1" />

                    <div class="flex items-center gap-2 pt-2">
                        <button type="button" :class="ui.linkButton(`text-2xs`)" :disabled="!gateDirty" v-action="saveGate">
                            {{ gate === undefined ? `Require approval` : `Save` }}
                        </button>
                        <span v-if="draftApprovers.length === 0" class="text-2xs text-warning">Name at least one person.</span>
                    </div>
                </template>
                <p v-else class="pt-0.5 text-2xs text-muted">The agent can use this without asking anybody.</p>
                <Notice v-if="gateError" :of="gateError" class="mt-2" />
            </div>

            <Notice v-if="error" :of="error" class="mt-2" />

            <div v-if="panelMode === `reveal`" class="mt-2">
                <div class="mb-1 flex items-center gap-2">
                    <span class="text-2xs font-medium uppercase tracking-wide text-subtle">Value</span>
                    <CopyButton :text="() => revealedValue ?? reveal(row.entry.key)" label="Copy" />
                </div>
                <code
                    class="block max-h-48 overflow-auto whitespace-pre-wrap break-all rounded-md border border-line bg-canvas px-3 py-2 font-mono text-xs text-content"
                    >{{ revealedValue }}</code
                >
            </div>

            <div v-else-if="panelMode === `edit`" class="mt-2 flex flex-col gap-1">
                <SecretField
                    :secret-key="row.entry.key"
                    :capability-id="row.entry.kind === `capability` ? row.entry.key : undefined"
                    :multiline="multiline"
                    no-hint
                    cancellable
                    @saved="editing = false"
                    @cancel="editing = false"
                />
                <button type="button" :class="ui.linkButton(`text-2xs`)" @click="multiline = !multiline">
                    {{ multiline ? `Single-line value` : `Multi-line value (SSH key, PEM…)` }}
                </button>
            </div>
        </template>
    </DisclosureRow>
</template>
