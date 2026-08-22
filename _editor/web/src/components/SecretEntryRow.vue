<script setup lang="ts">
import { BrandMark, ui, CopyButton, Notice, type NoticeModel, StatusBadge, vAction } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { timeAgo } from "@intentic/ui/format";
import { computed, ref, watch } from "vue";
import type { SecretRow } from "../pages/sandbox/secretRows";
import { reveal, useSecrets } from "../composables/secrets/useSecrets";
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
         row that happens to have grown something under it: the extension row's treatment, same wash. -->
    <div class="group @container" :class="expanded ? `bg-content/6` : `transition-colors hover:bg-content/4`">
        <div class="flex items-center gap-2 pl-2.5 pr-3">
            <button
                type="button"
                class="flex min-w-0 flex-1 items-center gap-2.5 py-2 text-left"
                :aria-expanded="expanded"
                :aria-controls="`secret-${row.entry.key}-panel`"
                @click="emit(`update:expanded`, !expanded)"
            >
                <Icon
                    name="chevron-right"
                    aria-hidden="true"
                    class="shrink-0 text-2xs text-subtle transition-transform group-hover:text-muted"
                    :class="expanded ? `rotate-90` : undefined"
                />
                <!-- The only thing on the row that is not words, and the only one that can be found without
                     reading: sixteen accounts of the same person differ solely in their last character. -->
                <BrandMark :size="20" :name="row.title" :logo="row.logo" :icon="row.icon" />
                <span class="min-w-0 flex-1">
                    <span class="flex min-w-0 items-baseline gap-2.5">
                        <span
                            v-tooltip.top.overflow="row.title"
                            class="min-w-0 flex-1 truncate @xl:w-56 @xl:flex-none"
                            :class="row.mono ? `font-mono text-sm text-content` : `text-sm font-medium text-content`"
                            >{{ row.title }}</span
                        >
                        <!-- Dropped rather than wrapped at rail width: the name is what the row is for, and the
                             panel below states everything this line was carrying. -->
                        <span
                            v-if="row.detail"
                            v-tooltip.top.overflow="row.detail"
                            class="hidden min-w-0 flex-1 truncate text-2xs text-muted @xl:block"
                            >{{ row.detail }}</span
                        >
                    </span>
                    <span
                        v-if="row.note && !expanded"
                        class="block truncate pt-0.5 text-2xs"
                        :class="row.attention ? `text-warning` : `text-subtle`"
                        >{{ row.note }}</span
                    >
                </span>
            </button>

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
        </div>

        <!-- The full record, one click away: where it lives, what uses it, and either the value or the editor.
             Indented to the name's column so it reads as belonging to the row above rather than as a section. -->
        <div v-if="expanded" :id="`secret-${row.entry.key}-panel`" class="border-t border-line py-2.5 pl-9 pr-3">
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
                <button type="button" class="self-start text-2xs text-link hover:underline" @click="multiline = !multiline">
                    {{ multiline ? `Single-line value` : `Multi-line value (SSH key, PEM…)` }}
                </button>
            </div>
        </div>
    </div>
</template>
