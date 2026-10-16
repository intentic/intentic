<script setup lang="ts">
import { PRIVACY_ALLOW_MAX } from "@intentic/sandbox-contract/schemas/privacy";
import { CopyButton, Icon, Row, ui } from "@intentic/ui";
import { formatFixed } from "@intentic/ui/format";
import { useT } from "@intentic/ui/i18n";
import { computed, nextTick, ref, useTemplateRef, watch } from "vue";
import { ALLOW_VALUE_MAX, type AllowListProblem, allowAdding, allowEdited, allowKey, allowMarked, allowRemoving, allowShown } from "./privacyShield";

// The values the shield leaves alone, drawn as words rather than rows: a line holds several, so a list of hundreds is a
// few lines tall, not a scroll of its own, and nothing is boxed inside the card it already sits in. One field both
// finds a value and adds one; a pasted list lands as many at once. Each press is one whole change, saved as it is
// made, so there is no draft to lose and no Save to forget.

const t = useT();

const { allow, ready } = defineProps<{
    /** The list as saved, in the order it was added; undefined until the policy has been read. */
    allow: readonly string[] | undefined;
    ready: boolean;
}>();

// A change is handed up as a function of the list it lands on, so a write builds on the policy as it stands then.
const emit = defineEmits<{ write: [change: (allow: readonly string[]) => string[]] }>();

const values = computed(() => allow ?? []);

// The one field: what is typed narrows the list, and Enter adds it.
const typed = ref(``);
const field = useTemplateRef<HTMLInputElement>(`field`);
const shown = computed(() => allowShown(values.value, typed.value));
const query = computed(() => typed.value.trim());
const listed = computed(() => query.value !== `` && values.value.some((value) => allowKey(value) === allowKey(query.value)));
const addable = computed(() => ready && query.value !== `` && !listed.value);

// Past a few lines the list stops, newest first, and the field is the way to any one value; the rest is a press away
// and then scrolls inside its own few lines, so the settings under it stay a short scroll off however long it grows.
const FIRST = 24;
const expanded = ref(false);
const visible = computed(() => (expanded.value ? shown.value : shown.value.slice(0, FIRST)));
const hidden = computed(() => shown.value.length - visible.value.length);
// Folding back is only offered while there is something to fold.
watch(
    () => shown.value.length <= FIRST,
    (short) => {
        if (short) {
            expanded.value = false;
        }
    },
);

// What the last press came to, said once under the field: a refusal, a count for a pasted list, or a removal to undo.
type Feedback =
    | { readonly kind: `problem`; readonly text: string }
    | { readonly kind: `info`; readonly text: string }
    | { readonly kind: `removed`; readonly value: string; readonly index: number };
const feedback = ref<Feedback | undefined>(undefined);
// What was just added, lit in the list so the eye finds it among hundreds.
const fresh = ref<ReadonlySet<string>>(new Set());

const problemText = (problem: AllowListProblem): string =>
    problem.kind === `tooMany`
        ? t(`sandbox.agentPrivacyShield.allowTooMany`, { max: PRIVACY_ALLOW_MAX, count: problem.count })
        : t(`sandbox.agentPrivacyShield.allowTooLong`, { max: ALLOW_VALUE_MAX, value: `${problem.value.slice(0, 40)}…` });

const add = (text: string): boolean => {
    const result = allowAdding(values.value, text);
    if (result.kind === `refused`) {
        feedback.value = { kind: `problem`, text: problemText(result.problem) };
        return false;
    }
    fresh.value = new Set(result.added.map(allowKey));
    if (result.added.length === 0) {
        feedback.value =
            result.already.length === 1
                ? { kind: `info`, text: t(`sandbox.agentPrivacyShield.neverMaskedAlready`, { value: result.already[0] }) }
                : undefined;
        return result.already.length > 0;
    }
    const parts = [
        result.added.length > 1 || result.already.length > 0
            ? t(`sandbox.agentPrivacyShield.neverMaskedAdded`, { count: formatFixed(result.added.length, 0) }, result.added.length)
            : undefined,
        result.already.length > 0
            ? t(`sandbox.agentPrivacyShield.neverMaskedSkipped`, { count: formatFixed(result.already.length, 0) }, result.already.length)
            : undefined,
    ].filter((part) => part !== undefined);
    feedback.value = parts.length > 0 ? { kind: `info`, text: parts.join(` `) } : undefined;
    emit(`write`, (current) => {
        const landed = allowAdding(current, text);
        return landed.kind === `added` ? landed.allow : [...current];
    });
    return true;
};

const submit = (): void => {
    if (query.value !== `` && add(query.value)) {
        typed.value = ``;
    }
};

// A pasted list is many values, not one long line: an input would fold its lines into spaces, so it is taken whole.
const paste = (event: ClipboardEvent): void => {
    const text = event.clipboardData?.getData(`text/plain`) ?? ``;
    if (!/\r?\n/.test(text.trim())) {
        return;
    }
    event.preventDefault();
    add(text);
};

const remove = (value: string): void => {
    const index = values.value.indexOf(value);
    feedback.value = { kind: `removed`, value, index };
    emit(`write`, (current) => allowRemoving(current, value));
};

// Undo puts the value back where it stood, unless it has come back some other way meanwhile.
const undo = (removed: { readonly value: string; readonly index: number }): void => {
    feedback.value = undefined;
    fresh.value = new Set([allowKey(removed.value)]);
    emit(`write`, (current) =>
        current.some((each) => allowKey(each) === allowKey(removed.value))
            ? [...current]
            : current.toSpliced(Math.min(removed.index, current.length), 0, removed.value),
    );
};

// A value is reached like any button: Enter opens it, Delete or Backspace takes it off, and the arrows step along the
// words. Taking one off hands the keyboard to its neighbour, so clearing several is a run of presses, not a hunt.
const valueButton = (item: Element | null | undefined): HTMLElement | null => item?.querySelector<HTMLElement>(`[data-value]`) ?? null;
const onValueKey = (event: KeyboardEvent, value: string): void => {
    const item = event.currentTarget instanceof HTMLElement ? event.currentTarget.closest(`li`) : null;
    if (event.key === `Delete` || event.key === `Backspace`) {
        event.preventDefault();
        const next = valueButton(item?.nextElementSibling) ?? valueButton(item?.previousElementSibling);
        remove(value);
        void nextTick(() => (next?.isConnected === true ? next.focus() : field.value?.focus()));
    } else if (event.key === `ArrowRight` || event.key === `ArrowLeft`) {
        const to = valueButton(event.key === `ArrowRight` ? item?.nextElementSibling : item?.previousElementSibling);
        if (to !== null) {
            event.preventDefault();
            to.focus();
        }
    }
};

// One value open for editing at a time, in its own word's place.
const editing = ref<string | undefined>(undefined);
const edited = ref(``);
const editField = useTemplateRef<HTMLInputElement[]>(`editField`);

const startEdit = async (value: string): Promise<void> => {
    editing.value = value;
    edited.value = value;
    await nextTick();
    editField.value?.[0]?.select();
};

const commitEdit = (): void => {
    const from = editing.value;
    if (from === undefined) {
        return;
    }
    const to = edited.value.trim();
    if (to === from) {
        editing.value = undefined;
        return;
    }
    const result = allowEdited(values.value, from, to);
    if (result.kind === `refused`) {
        feedback.value = { kind: `problem`, text: problemText(result.problem) };
        return;
    }
    editing.value = undefined;
    feedback.value = to === `` ? { kind: `removed`, value: from, index: values.value.indexOf(from) } : undefined;
    fresh.value = new Set(to === `` ? [] : [allowKey(to)]);
    emit(`write`, (current) => {
        const landed = allowEdited(current, from, to);
        return landed.kind === `edited` ? landed.allow : [...current];
    });
};

const cancelEdit = (): void => {
    editing.value = undefined;
    void nextTick(() => field.value?.focus());
};

// The whole list as one value per line: what a paste into this field, here or in another sandbox, takes back whole.
const asText = (): string => values.value.join(`\n`);
</script>

<template>
    <Row indent icon="check-circle" :title="t(`sandbox.agentPrivacyShield.neverMasked`)" :description="t(`sandbox.agentPrivacyShield.neverMaskedNote`)">
        <template v-if="values.length > 0" #meta>
            <span class="tabular-nums">{{ t(`sandbox.agentPrivacyShield.valuesCount`, { count: formatFixed(values.length, 0) }, values.length) }}</span>
        </template>
        <template v-if="values.length > 0" #control>
            <span v-tooltip.top="t(`sandbox.agentPrivacyShield.neverMaskedCopy`)"><CopyButton :text="asText" /></span>
        </template>
        <template #below>
            <div class="flex flex-col gap-2.5" :class="{ 'pointer-events-none opacity-60': !ready }">
                <div>
                    <!-- The one framed thing in the block. Add lives inside it and shows only when a press would add something. -->
                    <form class="ui-field-shell flex h-8 items-center gap-2 pl-2.5 pr-1" @submit.prevent="submit">
                        <Icon name="plus" class="shrink-0 text-2xs text-subtle" />
                        <input
                            ref="field"
                            v-model="typed"
                            type="text"
                            autocomplete="off"
                            spellcheck="false"
                            :maxlength="ALLOW_VALUE_MAX"
                            :disabled="!ready"
                            :aria-label="t(`sandbox.agentPrivacyShield.neverMaskedField`)"
                            :placeholder="t(`sandbox.agentPrivacyShield.neverMaskedPlaceholder`)"
                            class="field-bare min-w-0 flex-1 md:text-xs"
                            @input="feedback = undefined"
                            @paste="paste"
                            @keydown.esc="typed = ``"
                        />
                        <span v-if="query !== `` && shown.length > 0" class="shrink-0 text-2xs tabular-nums text-subtle">{{
                            t(`sandbox.agentPrivacyShield.neverMaskedMatches`, { count: formatFixed(shown.length, 0) }, shown.length)
                        }}</span>
                        <button v-if="addable" type="submit" :class="ui.textButton({ size: `xs`, flush: true }, `shrink-0 px-1.5`)">
                            {{ t(`ui.action.add`) }}
                        </button>
                    </form>

                    <p aria-live="polite" class="mt-1.5 flex min-h-4 flex-wrap items-baseline gap-x-1.5 text-2xs">
                        <span v-if="feedback?.kind === `problem`" class="text-danger">{{ feedback.text }}</span>
                        <span v-else-if="feedback?.kind === `info`" class="text-muted">{{ feedback.text }}</span>
                        <template v-else-if="feedback?.kind === `removed`">
                            <span class="text-muted">{{ t(`sandbox.agentPrivacyShield.neverMaskedRemoved`, { value: feedback.value }) }}</span>
                            <button type="button" :class="ui.textButton({ size: `xs`, flush: true })" @click="undo(feedback)">{{ t(`ui.action.undo`) }}</button>
                        </template>
                        <span v-else-if="listed" class="text-muted">{{ t(`sandbox.agentPrivacyShield.neverMaskedAlready`, { value: query }) }}</span>
                        <span v-else-if="query !== `` && shown.length === 0" class="text-muted">{{
                            t(`sandbox.agentPrivacyShield.neverMaskedNoMatch`, { value: query })
                        }}</span>
                        <span v-else-if="query !== ``" class="text-subtle">{{ t(`sandbox.agentPrivacyShield.neverMaskedAddAnyway`, { value: query }) }}</span>
                        <span v-else-if="values.length === 0" class="text-subtle">{{ t(`sandbox.agentPrivacyShield.neverMaskedEmpty`) }}</span>
                        <span v-else class="text-subtle">{{ t(`sandbox.agentPrivacyShield.neverMaskedHint`) }}</span>
                    </p>
                </div>

                <template v-if="visible.length > 0">
                    <!-- Words on lines, newest first. Unboxed: the card around the section is the only frame. A word reached by keyboard rings whole, its × included. -->
                    <ul
                        class="-m-0.5 flex flex-wrap gap-1 p-0.5"
                        :class="{ 'max-h-80 overflow-y-auto': expanded }"
                        :aria-label="t(`sandbox.agentPrivacyShield.neverMasked`)"
                    >
                        <li
                            v-for="value in visible"
                            :key="value"
                            class="flex h-6 min-w-0 max-w-full items-center rounded transition-colors has-[[data-value]:focus-visible]:ring-1 has-[[data-value]:focus-visible]:ring-inset has-[[data-value]:focus-visible]:ring-primary-500"
                            :class="
                                editing === value
                                    ? `bg-overlay ring-1 ring-inset ring-primary-500`
                                    : fresh.has(allowKey(value))
                                      ? `bg-primary-500/15 text-link`
                                      : `bg-content/5 text-content hover:bg-content/10`
                            "
                        >
                            <input
                                v-if="editing === value"
                                ref="editField"
                                v-model="edited"
                                type="text"
                                autocomplete="off"
                                spellcheck="false"
                                :size="Math.max(edited.length, 6)"
                                :maxlength="ALLOW_VALUE_MAX"
                                :aria-label="t(`sandbox.agentPrivacyShield.neverMaskedEdit`, { value })"
                                :class="ui.input({ size: `inline` }, `h-6 min-w-0 max-w-full bg-transparent px-2 text-xs`)"
                                @keydown.enter.prevent="commitEdit"
                                @keydown.esc.prevent="cancelEdit"
                                @blur="commitEdit"
                            />
                            <template v-else>
                                <button
                                    type="button"
                                    data-value
                                    class="h-full min-w-0 cursor-text truncate pl-2 pr-1 text-left text-xs focus-visible:outline-none"
                                    :aria-label="t(`sandbox.agentPrivacyShield.neverMaskedEdit`, { value })"
                                    v-tooltip.top.overflow="value"
                                    @click="startEdit(value)"
                                    @keydown="onValueKey($event, value)"
                                >
                                    <template v-for="(part, index) in allowMarked(value, query)" :key="index">
                                        <mark v-if="part.hit" class="rounded-sm bg-warning-500/25 text-inherit">{{ part.text }}</mark>
                                        <template v-else>{{ part.text }}</template>
                                    </template>
                                </button>
                                <!-- Off the tab order: Delete on the value does the same, so the keyboard isn't made to pass two stops per word. -->
                                <button
                                    type="button"
                                    tabindex="-1"
                                    :class="ui.iconButton({ size: `xs`, tone: `danger` }, `mr-0.5`)"
                                    :aria-label="t(`sandbox.agentPrivacyShield.neverMaskedRemove`, { value })"
                                    @click="remove(value)"
                                >
                                    <Icon name="times" class="text-3xs" />
                                </button>
                            </template>
                        </li>
                        <li v-if="hidden > 0" class="flex h-6 items-center px-1">
                            <button type="button" :class="ui.textButton({ size: `xs`, tone: `quiet`, flush: true })" @click="expanded = true">
                                {{ t(`sandbox.agentPrivacyShield.showMore`, { count: formatFixed(hidden, 0) }, hidden) }}
                            </button>
                        </li>
                    </ul>
                    <button v-if="expanded" type="button" :class="ui.textButton({ size: `xs`, tone: `quiet` })" @click="expanded = false">
                        <Icon name="chevron-up" class="text-3xs" />{{ t(`sandbox.agentPrivacyShield.showFewer`) }}
                    </button>
                </template>
            </div>
        </template>
    </Row>
</template>
