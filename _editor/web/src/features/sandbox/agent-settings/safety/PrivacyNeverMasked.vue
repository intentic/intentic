<script setup lang="ts">
import { PRIVACY_ALLOW_MAX } from "@intentic/sandbox-contract";
import { Button, Icon, Row, ui } from "@intentic/ui";
import { formatFixed } from "@intentic/ui/format";
import { useT } from "@intentic/ui/i18n";
import { computed, nextTick, ref, useTemplateRef } from "vue";
import { ALLOW_VALUE_MAX, type AllowListProblem, allowAdding, allowEdited, allowKey, allowRemoving, allowShown } from "./privacyShield";

// The values the shield leaves alone, kept as a list of values rather than a box of lines: one field both finds a value
// and adds one, every value is a row of its own to fix or remove, and a pasted list lands as many rows at once. Each
// press is one whole change, so it is saved as it is made; there is no draft to lose and no Save to forget.

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

// What the last press came to, said once beside the field: a refusal, a count for a pasted list, or a removal to undo.
type Feedback =
    | { readonly kind: `problem`; readonly text: string }
    | { readonly kind: `info`; readonly text: string }
    | { readonly kind: `removed`; readonly value: string; readonly index: number };
const feedback = ref<Feedback | undefined>(undefined);
// What was just added, marked in the list so the eye finds it among hundreds.
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

// One value open for editing at a time, in its own row's place.
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

// The list scrolls inside itself once it is long, so the rows under it on the page stay a short scroll away.
const LIST = `max-h-72 overflow-y-auto`;
</script>

<template>
    <Row icon="check-circle" :title="t(`sandbox.agentPrivacyShield.neverMasked`)" :description="t(`sandbox.agentPrivacyShield.neverMaskedNote`)">
        <template v-if="values.length > 0" #meta>
            <span class="tabular-nums">{{ t(`sandbox.agentPrivacyShield.valuesCount`, { count: formatFixed(values.length, 0) }, values.length) }}</span>
        </template>
        <template #below>
            <div class="flex flex-col gap-2" :class="{ 'pointer-events-none opacity-60': !ready }">
                <form class="flex items-center gap-2" @submit.prevent="submit">
                    <div class="flex h-8 min-w-0 flex-1 items-center gap-2 rounded-md border border-line bg-canvas px-2.5 focus-within:border-primary-500">
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
                            class="min-w-0 flex-1 bg-transparent text-xs text-content outline-none placeholder:text-subtle"
                            @input="feedback = undefined"
                            @paste="paste"
                            @keydown.esc="typed = ``"
                        />
                        <span v-if="query !== `` && values.length > 0" class="shrink-0 text-2xs tabular-nums text-subtle">{{
                            formatFixed(shown.length, 0)
                        }}</span>
                    </div>
                    <Button type="submit" size="small" :disabled="!ready || query === `` || listed">
                        {{ t(`ui.action.add`) }}
                    </Button>
                </form>

                <p aria-live="polite" class="flex min-h-4 flex-wrap items-baseline gap-x-1.5 text-2xs">
                    <span v-if="feedback?.kind === `problem`" class="text-danger">{{ feedback.text }}</span>
                    <span v-else-if="feedback?.kind === `info`" class="text-muted">{{ feedback.text }}</span>
                    <template v-else-if="feedback?.kind === `removed`">
                        <span class="text-muted">{{ t(`sandbox.agentPrivacyShield.neverMaskedRemoved`, { value: feedback.value }) }}</span>
                        <button type="button" :class="ui.linkButton(`text-2xs`)" @click="undo(feedback)">{{ t(`ui.action.undo`) }}</button>
                    </template>
                    <span v-else-if="listed" class="text-muted">{{ t(`sandbox.agentPrivacyShield.neverMaskedAlready`, { value: query }) }}</span>
                    <span v-else-if="query === ``" class="text-subtle">{{ t(`sandbox.agentPrivacyShield.neverMaskedHint`) }}</span>
                </p>

                <ul v-if="shown.length > 0" class="divide-y divide-line-subtle rounded-md border border-line" :class="LIST">
                    <li
                        v-for="value in shown"
                        :key="value"
                        class="group flex min-h-8 items-center gap-2 px-2.5 py-1"
                        :class="fresh.has(allowKey(value)) ? `bg-primary-500/10` : `hover:bg-content/[0.03]`"
                    >
                        <template v-if="editing === value">
                            <input
                                ref="editField"
                                v-model="edited"
                                type="text"
                                autocomplete="off"
                                spellcheck="false"
                                :aria-label="t(`sandbox.agentPrivacyShield.neverMaskedEdit`, { value })"
                                :class="ui.inputSm(`min-w-0 flex-1 font-mono`)"
                                @keydown.enter.prevent="commitEdit"
                                @keydown.esc.prevent="cancelEdit"
                                @blur="commitEdit"
                            />
                        </template>
                        <template v-else>
                            <span
                                class="min-w-0 flex-1 cursor-text truncate font-mono text-xs text-content"
                                v-tooltip.top.overflow="value"
                                @dblclick="startEdit(value)"
                                >{{ value }}</span
                            >
                            <!-- Out of the way until the row is pointed at or reached by keyboard; always there on a touch screen. -->
                            <span
                                class="flex shrink-0 items-center gap-0.5 opacity-0 transition-opacity group-focus-within:opacity-100 group-hover:opacity-100 [@media(hover:none)]:opacity-100"
                            >
                                <button
                                    type="button"
                                    :class="ui.iconButton(`size-6 text-subtle`)"
                                    :aria-label="t(`sandbox.agentPrivacyShield.neverMaskedEdit`, { value })"
                                    v-tooltip.top="t(`ui.action.edit`)"
                                    @click="startEdit(value)"
                                >
                                    <Icon name="pencil" class="text-2xs" />
                                </button>
                                <button
                                    type="button"
                                    :class="ui.iconButton(`size-6 text-subtle hover:text-danger`)"
                                    :aria-label="t(`sandbox.agentPrivacyShield.neverMaskedRemove`, { value })"
                                    v-tooltip.top="t(`ui.action.remove`)"
                                    @click="remove(value)"
                                >
                                    <Icon name="times" class="text-2xs" />
                                </button>
                            </span>
                        </template>
                    </li>
                </ul>
                <p v-else-if="values.length === 0" class="rounded-md border border-dashed border-line px-3 py-3 text-center text-2xs text-subtle">
                    {{ t(`sandbox.agentPrivacyShield.neverMaskedEmpty`) }}
                </p>
                <p v-else class="rounded-md border border-dashed border-line px-3 py-3 text-center text-2xs text-subtle">
                    {{ t(`sandbox.agentPrivacyShield.neverMaskedNoMatch`, { value: query }) }}
                </p>
            </div>
        </template>
    </Row>
</template>
