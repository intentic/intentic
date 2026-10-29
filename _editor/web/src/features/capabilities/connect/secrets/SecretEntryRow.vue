<script setup lang="ts">
import { BrandMark, ui, CopyButton, DisclosureRow, Notice, type NoticeModel, StatusBadge, vAction } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { computed, ref, watch } from "vue";
import type { SecretRow } from "../../../sandbox/secrets/secretRows";
import { reveal, useCredentialGates, useSecrets } from "../../../../models/capabilities/useSecrets";
import SecretApproval from "./SecretApproval.vue";
import SecretCredentialPolicy from "./SecretCredentialPolicy.vue";
import SecretDevicePanel from "./SecretDevicePanel.vue";
import SecretFact from "./SecretFact.vue";
import SecretHostsEditor from "./SecretHostsEditor.vue";
import SecretProgramsEditor from "./SecretProgramsEditor.vue";
import SecretValue from "./SecretValue.vue";
import { lastUseWords, storedWords } from "./secretFacts";
import { FIXED_VALUE, VALUE_NOTE, VALUE_TEXT } from "./secretLook";
import { useKeyrings } from "./useKeyrings";
import { useT } from "@intentic/ui/i18n";

// One secret, one line, until asked otherwise: a mark, a name, what tells it apart, and (only when owed) a due badge.
// Reveal/copy/set/remove fade in on hover, focus or touch rather than crowding a scanned list. Open, it is two short
// columns of facts, each a label and its answer: what it is (its value, its last use, where it lives) and when it asks
// first (who releases it, where it may go, what it may be typed into, how a connection hands it over). Every answer is
// where it is changed, in a panel hanging off it with its own Save; nothing on the open row is a form at rest.
// Expansion belongs to the parent (one row open at a time); closing drops whatever the row opened with.

const t = useT();

const { row, expanded } = defineProps<{ row: SecretRow; expanded: boolean }>();
const emit = defineEmits<{ "update:expanded": [expanded: boolean] }>();

const { remove } = useSecrets();
// Editing a rule, and reading a value, is for whoever runs secrets (the daemon's routes enforce it); everybody else reads
// the same answers.
const { runsSecrets } = useCredentialGates();

// Held here rather than in the value's own fact, so the header's buttons on a closed row open it onto the same place.
const revealedValue = ref<string | undefined>(undefined);
const replacing = ref(false);
const typing = ref(false);
const confirming = ref(false);
const revealError = ref<NoticeModel | undefined>(undefined);
const error = ref<NoticeModel | undefined>(undefined);

const entry = computed(() => row.entry);
// A pointer to a keyring entry on one of the owner's computers: its value never comes here, so nothing shows, copies or
// sets it, and its rules are changed on that computer.
const onComputer = computed(() => row.group === `device`);
// Type into… needs a computer with a keyring; a sandbox with none never sees the button.
const { keyrings, online } = useKeyrings();
const canType = computed(() => row.typeable && keyrings.value.length > 0);
// A value exists and this viewer is allowed to read it: gates both Reveal and Copy. The daemon reveals one to whoever runs
// secrets, and a gated one only to its approvers, which the inventory already says as `revealable` (secrets.routes.ts
// `mayReveal`).
const canReveal = computed(() => entry.value.status !== `missing` && entry.value.revealable && runsSecrets.value && !onComputer.value);
// Nominal is silent: a connection that is simply working says so by carrying nothing.
const state = computed(() => (row.state !== undefined && row.state.rank < 3 ? row.state : undefined));

const lastUse = computed(() => (entry.value.lastUse === undefined ? undefined : lastUseWords(entry.value.lastUse)));
const stored = computed(() => storedWords(entry.value));

watch(
    () => expanded,
    (open) => {
        if (open) {
            return;
        }
        replacing.value = false;
        typing.value = false;
        revealedValue.value = undefined;
        confirming.value = false;
        revealError.value = undefined;
        error.value = undefined;
    },
);

const open = (): void => emit(`update:expanded`, true);

const toggleReveal = async (): Promise<void> => {
    revealError.value = undefined;
    if (revealedValue.value !== undefined) {
        revealedValue.value = undefined;
        return;
    }
    open();
    try {
        revealedValue.value = await reveal(entry.value.key);
    } catch (err) {
        revealError.value = noticeFrom(err, t(`capabilities.secretEntryRow.couldNotReveal`));
    }
};

const startReplace = (): void => {
    open();
    replacing.value = true;
};

const startType = (): void => {
    open();
    typing.value = true;
};

const removeKey = async (): Promise<void> => {
    error.value = undefined;
    try {
        await remove.mutateAsync(entry.value.key);
    } catch (err) {
        confirming.value = false;
        open();
        error.value = noticeFrom(err, t(`capabilities.secretEntryRow.couldNotRemove`));
    }
};

// Centres its glyph in a fixed 24px box via flex, matching CopyButton's centring, so icon buttons in one cluster
// don't visually drift apart.
const ACTION = ui.iconButton({ tone: `subtle` }, `disabled:opacity-40`);
</script>

<template>
    <!-- Header and panel share one tint while open, reading as a single block; the wash, chevron and rail are <DisclosureRow>'s. -->
    <DisclosureRow class="@container" :open="expanded" @update:open="emit(`update:expanded`, !expanded)">
        <template #lead="{ mark }">
            <!-- The only non-text element, findable without reading (accounts differing only in a last character). -->
            <BrandMark plain :size="mark" :name="row.title" :logo="row.logo" :icon="row.icon" />
        </template>

        <template #title>
            <span class="flex min-w-0 items-baseline gap-2.5">
                <span
                    v-tooltip.top.overflow="row.title"
                    class="min-w-0 flex-1 truncate @xl:w-56 @xl:flex-none"
                    :class="row.mono ? `font-mono` : ``"
                    >{{ row.title }}</span
                >
                <!-- Dropped rather than wrapped at rail width: the name is what the row is for; the panel below repeats the detail. -->
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
                    <!-- Shortcuts for a closed row: open, each of these is a labelled button beside the value it acts on. -->
                    <template v-if="!expanded">
                        <button
                            v-if="canType"
                            v-tooltip.top="{
                                title: t(`capabilities.typeInto.title`),
                                note: online.length > 0 ? t(`capabilities.typeInto.tooltipNote`) : t(`capabilities.typeInto.noneOnlineShort`),
                            }"
                            type="button"
                            :class="ACTION"
                            :aria-label="t(`capabilities.typeInto.title`)"
                            @click="startType"
                        >
                            <Icon name="keyboard-tab" class="text-xs" />
                        </button>
                        <button
                            v-if="row.entry.status !== `missing` && !onComputer"
                            v-tooltip.top="{ title: t(`capabilities.secretEntryRow.reveal`), note: t(`capabilities.secretEntryRow.whoReveals`) }"
                            type="button"
                            :class="ACTION"
                            :disabled="!canReveal"
                            :aria-label="t(`capabilities.secretEntryRow.revealValueWho`)"
                            v-action="toggleReveal"
                        >
                            <Icon name="eye" class="text-xs" />
                        </button>
                        <CopyButton v-if="canReveal" v-tooltip.top="t(`capabilities.secretEntryRow.copyValue`)" :text="() => reveal(row.entry.key)" />
                        <button
                            v-if="row.editable"
                            v-tooltip.top="t(`capabilities.secretEntryRow.setUpdate`)"
                            type="button"
                            :class="ACTION"
                            :aria-label="t(`capabilities.secretEntryRow.setUpdateValue`)"
                            @click="startReplace"
                        >
                            <Icon name="pencil" class="text-xs" />
                        </button>
                    </template>
                    <template v-if="row.removable">
                        <button
                            v-if="!confirming"
                            v-tooltip.top="t(`ui.action.remove`)"
                            type="button"
                            :class="ACTION"
                            :aria-label="t(`ui.action.remove`)"
                            @click="confirming = true"
                        >
                            <Icon name="trash" class="text-xs" />
                        </button>
                        <template v-else>
                            <!-- allow(recipes): THE ARMED SECOND PRESS of a two-step remove, beside a neutral cancel:
                                 red before the pointer reaches it is what says this one deletes. The danger tone is
                                 neutral at rest, which is right for a first press and wrong for the confirmation of
                                 one. -->
                            <button
                                v-tooltip.top="t(`capabilities.secretEntryRow.confirmRemove`)"
                                type="button"
                                :class="ui.iconButton({ tone: `danger` }, `text-danger`)"
                                :aria-label="t(`capabilities.secretEntryRow.confirmRemove`)"
                                v-action="removeKey"
                            >
                                <Icon name="check" class="text-xs" />
                            </button>
                            <button
                                v-tooltip.top="t(`ui.action.cancel`)"
                                type="button"
                                :class="ACTION"
                                :aria-label="t(`capabilities.secretEntryRow.cancelRemove`)"
                                @click="confirming = false"
                            >
                                <Icon name="times" class="text-xs" />
                            </button>
                        </template>
                    </template>
                </span>
            </span>
        </template>

        <!-- The full record, one click away: what it is on one side, when it asks first on the other. -->
        <template #below>
            <!-- Dropped from the header at rail width, so said here instead: what tells it apart. -->
            <p v-if="row.detail && !onComputer" class="pb-1.5 text-xs text-muted @xl:hidden">{{ row.detail }}</p>
            <div class="flex flex-col gap-3 @3xl:flex-row @3xl:gap-8">
                <dl class="flex min-w-0 flex-1 flex-col gap-1">
                    <SecretValue
                        v-model:revealed="revealedValue"
                        v-model:replacing="replacing"
                        v-model:typing="typing"
                        :row="row"
                        :can-reveal="canReveal"
                        :can-type="canType"
                        :error="revealError"
                        @reveal="toggleReveal"
                    />
                    <SecretDevicePanel v-if="onComputer" :row="row" part="about" />
                    <!-- The use ledger's newest row: absent for a secret never yet spent. -->
                    <SecretFact v-if="lastUse" :label="t(`capabilities.secretFacts.lastUsed`)">
                        <span :class="FIXED_VALUE">
                            <span :class="VALUE_TEXT">{{ lastUse.said }}</span>
                            <code
                                v-if="lastUse.code"
                                v-tooltip.top.overflow="lastUse.code"
                                class="block max-w-full truncate font-mono text-xs leading-5 text-subtle"
                                >{{ lastUse.code }}</code
                            >
                            <span v-if="lastUse.note" :class="VALUE_NOTE">{{ lastUse.note }}</span>
                        </span>
                    </SecretFact>
                    <SecretFact v-if="!onComputer" :label="t(`capabilities.secretFacts.storedIn`)">
                        <span :class="FIXED_VALUE">
                            <!-- A path wraps after a slash, never inside a name. -->
                            <span v-if="stored.path" class="[overflow-wrap:anywhere] font-mono text-xs leading-5 text-content"
                                ><template v-for="(part, index) of stored.said.split(`/`)" :key="index"
                                    ><template v-if="index > 0">/<wbr /></template>{{ part }}</template
                                ></span
                            >
                            <span v-else :class="VALUE_TEXT">{{ stored.said }}</span>
                            <span v-if="stored.note" :class="VALUE_NOTE">{{ stored.note }}</span>
                        </span>
                    </SecretFact>
                    <SecretFact v-if="row.entry.ci !== undefined" :label="t(`capabilities.secretFacts.ciLabel`)">
                        <span :class="FIXED_VALUE">
                            <span :class="row.entry.ci.synced ? VALUE_TEXT : `text-sm text-warning`">{{
                                row.entry.ci.synced ? t(`capabilities.secretFacts.ciSynced`) : t(`capabilities.secretFacts.ciOutOfDate`)
                            }}</span>
                        </span>
                    </SecretFact>
                </dl>

                <!-- When it asks first. Off for nearly everything by design: these are for the few credentials where one wrong
                     use is the incident. A mounted account's credential has no host guard, since no command carries it. -->
                <dl
                    v-if="row.gateSubject !== undefined"
                    class="flex min-w-0 flex-1 flex-col gap-1 @3xl:border-l @3xl:border-line-subtle @3xl:pl-6"
                    data-secret-rules
                >
                    <SecretApproval :row="row" />
                    <SecretHostsEditor v-if="!row.mountedForTurn && !onComputer" :row="row" />
                    <SecretProgramsEditor v-if="row.programsHere" :row="row" />
                    <SecretDevicePanel v-if="onComputer" :row="row" part="rules" />
                    <SecretCredentialPolicy :row="row" />
                    <p v-if="!runsSecrets" class="pt-1 text-xs text-subtle">{{ t(`capabilities.secretFacts.whoChanges`) }}</p>
                </dl>
            </div>

            <Notice v-if="error" :of="error" class="mt-2" />
        </template>
    </DisclosureRow>
</template>
