<!-- A `keyValue` field: rows of a name and a value with add and remove, standing in for a `KEY=VALUE` textarea. The
     form's answer stays the text those lines make (models/capabilities/keyValue.ts), so nothing downstream changes. -->
<script setup lang="ts">
import type { CapabilityField } from "@intentic/extension-manifest";
import { ui } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { ref, watch } from "vue";
import { type KeyValueRow, keyNameValid, keyValueText, parseKeyValues, pastedRows } from "../../models/capabilities/keyValue";

const t = useT();

const { field, values, placeholder, alarm } = defineProps<{
    field: CapabilityField;
    /** The form's live answers: this row writes its own key, the rows' text. */
    values: Record<string, string>;
    /** What an empty answer means: on an edit, that the connection keeps what it holds. */
    placeholder?: string | undefined;
    alarm?: string | undefined;
}>();

const emit = defineEmits<{ edited: []; left: [] }>();

// The rows on screen, which may hold one not yet named (just added, or being typed): only named rows reach the answer.
const rows = ref<KeyValueRow[]>(parseKeyValues(values[field.key]));

// Writes the rows back as the answer, and says the answer changed.
const commit = (next: KeyValueRow[]): void => {
    rows.value = next;
    values[field.key] = keyValueText(next);
    emit(`edited`);
};

// The answer replaced from outside (the form re-seeded for another connection, a dev autofill): the rows follow it,
// unless it is already what they say.
watch(
    () => values[field.key],
    (text) => {
        if ((text ?? ``) !== keyValueText(rows.value)) {
            rows.value = parseKeyValues(text);
        }
    },
);

const update = (index: number, part: Partial<KeyValueRow>): void =>
    commit(rows.value.map((row, at) => (at === index ? { ...row, ...part } : row)));
// SAFETY: bound only to the row's own <input> elements below, so the event's target is that input.
const typed = (event: Event): string => (event.target as HTMLInputElement).value;

const add = (): void => {
    rows.value = [...rows.value, { name: ``, value: `` }];
};

const remove = (index: number): void => commit(rows.value.filter((_row, at) => at !== index));

// A whole block pasted into a name box (a .env, an `export` line) becomes rows in that one's place.
const onNamePaste = (index: number, event: ClipboardEvent): void => {
    const pasted = pastedRows(event.clipboardData?.getData(`text`) ?? ``);
    if (pasted === undefined) {
        return;
    }
    event.preventDefault();
    commit([...rows.value.slice(0, index), ...pasted, ...rows.value.slice(index + 1)]);
};
</script>

<template>
    <!-- A div, not a label: a label forwards a click anywhere inside it to its first control. -->
    <div class="ui-field">
        <span class="ui-field-label">{{ field.label }}{{ field.optional ? t(`capabilities.capabilityFieldRow.optional`) : "" }}</span>
        <div v-for="(row, index) in rows" :key="index" class="flex flex-col gap-1">
            <div class="flex items-center gap-2">
                <input
                    :value="row.name"
                    :aria-label="t(`capabilities.keyValueField.name`)"
                    :placeholder="t(`capabilities.keyValueField.name`)"
                    autocapitalize="off"
                    spellcheck="false"
                    :class="[ui.input('w-2/5 min-w-0 font-mono'), keyNameValid(row.name) ? '' : 'ui-field-error-box']"
                    @input="update(index, { name: typed($event) })"
                    @paste="onNamePaste(index, $event)"
                    @blur="emit('left')"
                />
                <input
                    :value="row.value"
                    :type="field.secret ? 'password' : 'text'"
                    :autocomplete="field.secret ? 'off' : undefined"
                    :aria-label="t(`capabilities.keyValueField.valueOf`, { name: row.name || t(`capabilities.keyValueField.name`) })"
                    :placeholder="t(`capabilities.keyValueField.value`)"
                    spellcheck="false"
                    :class="ui.input('min-w-0 flex-1 font-mono')"
                    @input="update(index, { value: typed($event) })"
                    @blur="emit('left')"
                />
                <button
                    type="button"
                    :class="ui.textButton({ tone: `quiet` })"
                    :aria-label="t(`capabilities.keyValueField.remove`, { name: row.name || t(`capabilities.keyValueField.name`) })"
                    @click="remove(index)"
                >
                    <Icon name="trash" class="text-2xs" />
                </button>
            </div>
            <span v-if="!keyNameValid(row.name)" class="ui-field-error">
                <Icon name="exclamation-triangle" class="text-2xs" />
                {{ t(`capabilities.keyValueField.badName`) }}
            </span>
        </div>
        <div class="flex flex-wrap items-center gap-x-3 gap-y-1">
            <button type="button" :class="ui.textButton({ size: `xs` })" @click="add">
                <Icon name="plus" class="text-2xs" />
                {{ t(`capabilities.keyValueField.add`) }}
            </button>
            <!-- On an edit the stored values are never shown, so what an empty list means is said instead. -->
            <span v-if="rows.length === 0 && placeholder" class="text-2xs text-subtle">{{ placeholder }}</span>
        </div>
        <span v-if="alarm" class="ui-field-error">
            <Icon name="exclamation-triangle" class="text-2xs" />
            {{ alarm }}
        </span>
        <span v-else-if="field.hint" class="text-2xs text-muted">{{ field.hint }}</span>
    </div>
</template>
