<script setup lang="ts">
import { BrandMark, ui, CopyButton, DisclosureRow, Notice, type NoticeModel, SegmentedControl, StatusBadge, vAction } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { timeAgo } from "@intentic/ui/format";
import { computed, ref, watch } from "vue";
import type { CredentialGateScope } from "@intentic/sandbox-contract";
import type { SecretRow } from "../pages/sandbox/secretRows";
import { reveal, useCredentialGates, useSecrets } from "../composables/secrets/useSecrets";
import ToggleSwitch from "primevue/toggleswitch";
import SecretField from "./SecretField.vue";

/* ONE SECRET, on one line until asked otherwise: the extension row's shape, for the extension row's reason:
 * this is a list read by scanning, and everything below the fold was being paid for on every row of it.
 *
 * THE LINE ANSWERS "WHICH ONE IS THIS", AND NOTHING ELSE. A mark, the name, what tells it apart (what uses it,
 * or whose account it is), and (only when there is one) the fact that something is owed. The provenance, the
 * revealed value and the editor open below it. A healthy row carries no badge and no dot: the tab used to print
 * a green dot beside every one of nineteen connected credentials, which is nineteen pixels of ink saying
 * "normal" and nothing left to notice the one that isn't.
 *
 * THE FOUR BUTTONS WAIT TO BE REACHED FOR. Reveal, copy, set and remove are identical on every row and rarely
 * the reason anyone opened the tab, so at twenty rows they are eighty pieces of furniture between the reader and
 * the name they came to find. They fade in on hover and on keyboard focus, and they are simply THERE on a touch
 * screen and on an open row, so the path that never needs a pointer (tap the row, act in the panel) is whole.
 *
 * EXPANSION IS THE PARENT'S, not the row's: the tab keeps one row open at a time, so a list being scanned never
 * grows unpredictably under the pointer. Everything the row opened WITH: a revealed value, a half-typed
 * replacement, a remove waiting to be confirmed: is dropped when it closes, because none of those should be
 * lying in wait behind a chevron the next time somebody clicks it. */

const { row, expanded } = defineProps<{ row: SecretRow; expanded: boolean }>();
const emit = defineEmits<{ "update:expanded": [expanded: boolean] }>();

const { remove } = useSecrets();

/* THE APPROVAL BLOCK. Editing a gate is the OWNER's alone, enforced at the daemon's route because a
 * maintainer is exactly who a gate is sometimes written about; what this file does is render the read-only
 * form for everybody else rather than offering controls that would 403 (secrets/credential-gate.ts).
 *
 * The DRAFT is local until Save, unlike every other control on this row. A gate is three decisions that only
 * make sense together — on/off, who, and how far one release goes — and writing each keystroke through would
 * mean a moment where a credential is gated to nobody, which the route rightly refuses (a gate with an empty
 * approver list is a lock, not a gate). So the draft is assembled here and sent once. */
const { gateFor, approverChoices, isOwner, setGate, removeGate } = useCredentialGates();

const gate = computed(() => (row.gateSubject === undefined ? undefined : gateFor(row.gateSubject)));
const draftApprovers = ref<string[]>([]);
const draftScope = ref<CredentialGateScope>(`use`);
const gateError = ref<NoticeModel | undefined>(undefined);

/* The draft follows the SERVER's answer whenever the row opens or the policy changes under it, which is what
 * keeps a second tab's edit from being silently overwritten by a stale draft sitting behind a chevron. A
 * session-shaped credential opens on `conversation` because that is the only scope it can have. */
watch(
    [() => expanded, gate],
    () => {
        draftApprovers.value = [...(gate.value?.approvers ?? [])];
        draftScope.value = gate.value?.scope ?? (row.sessionShaped ? `conversation` : `use`);
        gateError.value = undefined;
    },
    { immediate: true },
);

const toggleApprover = (email: string): void => {
    draftApprovers.value = draftApprovers.value.includes(email)
        ? draftApprovers.value.filter((entry) => entry !== email)
        : [...draftApprovers.value, email];
};

// Saveable only with somebody on it, and only when something actually changed: the route refuses an empty
// list, and re-sending the gate that is already stored is a write nobody asked for.
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

/* The app's bare icon button rather than a tenth hand-rolled spelling of it, and here that is a fix, not
 * tidying. A glyph left to INLINE layout rides the row's text baseline, and Icon.vue nudges every svg down
 * 0.125em so an icon sits right beside words; in a button whose only child is that icon there are no words, so
 * the nudge is just a drop of a pixel or two: by an amount that moves with whatever font-size the button
 * happens to inherit. The copy button beside these already centred its glyph with flex, so the four actions in
 * one cluster did not agree on where the middle was. `ui.iconButton` centres with flex in a fixed 24px box,
 * which is exactly zero offset under every type scale, so they cannot drift apart again. */
const ACTION = ui.iconButton(`text-subtle disabled:opacity-40 disabled:hover:bg-transparent disabled:hover:text-subtle`);
</script>

<template>
    <!-- Header and panel share one tint while open, so an expanded row reads as a single block rather than as a
         row that happens to have grown something under it. That wash, the chevron, the ARIA and the rail under
         the name are <DisclosureRow>'s; the four hand-rolled copies of them that used to be here are the reason
         `pl-9` in this file, `pl-10` next door and `pl-8` in the automations list were three answers to one
         question. `body="rail"`: what opens is the secret's RECORD — where it lives, what last spent it — and
         evidence hangs off the name it is about.

         No `density`: the <RowGroup> this row is dropped into says `compact` once for the whole list, and the
         row, its outline and every note between them read it from there. -->
    <DisclosureRow class="@container" :open="expanded" @update:open="emit(`update:expanded`, !expanded)">
        <template #lead="{ mark }">
            <!-- The only thing on the row that is not words, and the only one that can be found without
                 reading: sixteen accounts of the same person differ solely in their last character.

                 Sized by the row's tier rather than by this file, which had it at 20 while the extensions and
                 environment lists one tab away had the same mark at 22: near enough to look like a mistake and
                 far enough to be one. The tier itself comes from the <RowGroup> this row is dropped into. -->
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
                <!-- Dropped rather than wrapped at rail width: the name is what the row is for, and the
                     panel below states everything this line was carrying. -->
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
            <!-- The use ledger's newest row: when the agent last actually spent this, put into a command, or
                 typed into a page, and where it went. Absent for a secret that has only ever sat here. -->
            <p v-if="row.entry.lastUse" class="pt-0.5 text-2xs text-muted">
                used by the agent {{ timeAgo(row.entry.lastUse.at, { days: true }) }}
                <template v-if="row.entry.lastUse.detail">
                    ·
                    <span v-if="row.entry.lastUse.lane === `browser`">typed on {{ row.entry.lastUse.detail }}</span>
                    <span v-else class="font-mono text-subtle">{{ row.entry.lastUse.detail }}</span>
                </template>
            </p>
            <!-- WHO HAS TO RELEASE THIS. Off for nearly everything, which is the design: gating is for the few
                 credentials where one wrong use is the incident, and a sandbox where everything asks is one
                 where nobody reads the cards. Only the owner can change it (the daemon's route is the rule,
                 this is the courtesy), and only rows with something to release carry the block at all. -->
            <div v-if="row.gateSubject !== undefined" class="mt-3 border-t border-line pt-2">
                <div class="flex items-center justify-between gap-2">
                    <span class="text-2xs font-medium uppercase tracking-wide text-subtle">Needs approval</span>
                    <ToggleSwitch
                        v-if="isOwner"
                        :model-value="gate !== undefined"
                        v-tooltip.top="
                            gate === undefined
                                ? `Require a named person to release this before the agent can use it`
                                : `Let the agent use this without asking anybody`
                        "
                        aria-label="Needs approval"
                        @update:model-value="
                            (value: boolean) => {
                                if (value) {
                                    draftApprovers = approverChoices.slice(0, 1);
                                    draftScope = row.sessionShaped ? `conversation` : `use`;
                                } else {
                                    void clearGate();
                                }
                            }
                        "
                    />
                </div>

                <!-- Not the owner: the state, and why the controls are not here. Said rather than hidden — a
                     maintainer who can see a gate but not change it needs to know which of those it is. -->
                <p v-if="!isOwner" class="pt-0.5 text-2xs text-muted">
                    <template v-if="gate">
                        Only {{ gate.approvers.join(` or `) }} can release this, and
                        {{ gate.scope === `conversation` ? `one release covers the rest of a conversation` : `every use asks again` }}. Only the
                        owner can change this.
                    </template>
                    <template v-else>Nobody has to approve this. Only the owner can change that.</template>
                </p>

                <template v-else-if="gate !== undefined || draftApprovers.length > 0">
                    <!-- The approvers, as an exact list rather than a role floor: "only Bob" is the sentence
                         people mean, and a floor cannot say it. The owner appears here like anybody else,
                         because they are not an implicit approver — the list is exactly who may click. -->
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
                        <span v-if="approverChoices.length === 0" class="text-2xs text-muted"
                            >Nobody can be named yet: give somebody access first, on the Access tab.</span
                        >
                    </div>

                    <!-- HOW FAR ONE RELEASE GOES, and the one control that is sometimes not a choice: a
                         signed-in browser profile or a running MCP server is mounted for a whole turn, so
                         there is no "one use" to release. The daemon forces those, and saying so is better
                         than offering a switch that gets overridden. -->
                    <p class="pt-2 text-2xs text-muted">How long one release lasts</p>
                    <p v-if="row.sessionShaped" class="pt-0.5 text-2xs text-subtle">
                        For the rest of the conversation. A signed-in account is loaded for a whole turn, so it cannot be released for a single
                        use.
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
