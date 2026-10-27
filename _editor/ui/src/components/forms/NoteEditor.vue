<!-- One markdown note, read and written in the same place: pressing its text puts it under the caret where it stands, it
     writes itself as it is typed (<MarkdownDocument save="auto">), and leaving it renders it again. No pencil to press first,
     no Save or Cancel that swap in for the frame's own actions. -->
<script setup lang="ts">
import Button from "../primitives/Button.vue";
import { useT } from "../../i18n/index.js";
import { ui } from "../../lib/ui.js";
import CopyButton from "../primitives/CopyButton.vue";
import Icon from "../primitives/Icon.vue";
import MarkdownDocument from "../markdown/MarkdownDocument.vue";
import ScrollFrame from "../layout/ScrollFrame.vue";
import Notice from "../feedback/Notice.vue";
import { toneTint } from "../../lib/tone.js";
import { nextTick, ref } from "vue";

const { verb, paged = false, writable = true, editing } = defineProps<{
    /** The note's name, in the frame's header. */
    title: string;
    /** The file as it stands on disk: what Copy copies, whatever is on screen. */
    raw: string;
    /** Is a draft open: the document is under the caret, and writes itself as it is typed. */
    editing: boolean;
    /** Nothing has arrived yet. Suppressed while editing: a draft is already on screen. */
    loading?: boolean;
    saving?: boolean;
    removing?: boolean;
    /** Whatever went wrong: the read or either write. */
    error?: string;
    /** What deleting this kind of note is called; spells the tooltip, accessible name and confirm button text. */
    verb?: string;
    /** The page owns the scroll: the note runs full length and the header pins itself. */
    paged?: boolean;
    /** Whether pressing the text starts writing; false while the frame shows something else in the note's place (a map). */
    writable?: boolean;
}>();

const t = useT();
// `save` carries `keepOpen`: true for the writes made while typing, absent for the one made on the way out, after which
// the caller closes the draft (useNoteDraft's `saveDraft` takes exactly that argument). `cancel` is no longer emitted:
// what was typed has been written, so there is nothing to throw away. It stays declared for callers that still bind it.
const emit = defineEmits<{ edit: []; cancel: []; save: [keepOpen?: boolean]; remove: [] }>();

/** The source surface's text. The caller binds its draft-or-file computed straight to this. */
const source = defineModel<string>("source", { required: true });
/** Whether the delete confirmation is showing: a model because this component's own trash button opens it. */
const confirming = defineModel<boolean>("confirming", { default: false });

const surface = ref<HTMLElement | null>(null);
const doc = ref<InstanceType<typeof MarkdownDocument>>();

// A press that followed a link, pressed a button or selected words is reading, not asking to write.
const pressToWrite = (event: MouseEvent): void => {
    const target = event.target instanceof Element ? event.target : undefined;
    if (!writable || editing || window.getSelection()?.toString() || target?.closest(`a, button, [data-kb]`)) {
        return;
    }
    emit(`edit`);
    void nextTick(() => doc.value?.focus());
};
// The keyboard's way in: Enter on the note itself.
const keyToWrite = (event: KeyboardEvent): void => {
    if (!writable || editing || event.target !== event.currentTarget) {
        return;
    }
    event.preventDefault();
    emit(`edit`);
    void nextTick(() => doc.value?.focus());
};
// Leaving the text, by a press elsewhere, Tab or Esc, writes the last of it and renders it again.
const leave = (event: FocusEvent): void => {
    const next = event.relatedTarget instanceof Node ? event.relatedTarget : null;
    if (editing && !surface.value?.contains(next)) {
        doc.value?.commit();
        emit(`save`);
    }
};
const escape = (): void => {
    doc.value?.commit();
    emit(`save`);
    void nextTick(() => surface.value?.focus());
};
</script>

<template>
    <!-- `grow` only applies when bounded; `flex-1` resolves to nothing in an auto-height parent, collapsing it. -->
    <ScrollFrame :grow="!paged" :scroll="!paged" :sticky="paged" :title="title">
        <template v-if="$slots[`lead`]" #lead><slot name="lead" /></template>
        <!-- The name, when the caller draws it (renamed in place); `title` still names the frame everywhere else. -->
        <template v-if="$slots[`title`]" #title><slot name="title" /></template>

        <template v-if="$slots[`badges`]" #badges><slot name="badges" /></template>

        <template v-if="$slots[`description`]" #description><slot name="description" /></template>
        <template v-if="$slots[`meta`]" #meta><slot name="meta" /></template>

        <!-- The same actions whether the note is being read or written: nothing in the frame moves when the caret arrives. -->
        <template #actions>
            <slot name="actions" />
            <CopyButton :text="raw" v-tooltip.top="t(`ui.noteEditor.copyMarkdown`)" />
            <button
                type="button"
                :class="ui.iconButton({ size: `md`, tone: `danger` })"
                :aria-label="t(`ui.noteEditor.note`, { verb: verb ?? t(`ui.action.delete`) })"
                v-tooltip.top="verb ?? t(`ui.action.delete`)"
                @click="confirming = true"
            >
                <Icon name="trash" />
            </button>
        </template>

        <template #strips>
            <slot v-if="!editing" name="strips" />
            <div v-if="confirming" :class="toneTint(`danger`, `strong`, `flex flex-wrap items-center justify-between gap-2 border-b px-4 py-2.5`)">
                <span class="text-xs text-danger"><slot name="confirm" /></span>
                <div class="flex shrink-0 items-center gap-1.5">
                    <Button :label="t(`ui.noteEditor.keep`)" size="small" tier="quiet" @click="confirming = false" />
                    <Button
                        tier="accent"
                        :label="t(`ui.noteEditor.it`, { verb: verb ?? t(`ui.action.delete`) })"
                        size="small"
                        tone="danger"
                        :loading="removing"
                        @click="emit(`remove`)"
                    />
                </div>
            </div>
            <Notice v-if="error" tone="danger" strip class="px-4">{{ error }}</Notice>
        </template>

        <p v-if="loading && !editing" class="px-4 py-6 text-xs text-subtle">{{ t(`ui.status.loading`) }}</p>
        <!-- One press target for the note, read or written: a press on the text (or Enter on it) puts it under the caret
             where it stands; the document then writes itself a moment after the typing stops, and leaving renders the
             caller's reading of it again. It stays focusable while written (-1, not removed): a focused box that stops
             being focusable is blurred by the browser, which would read as leaving the moment the caret arrived. -->
        <div
            v-else
            ref="surface"
            :tabindex="writable ? (editing ? -1 : 0) : undefined"
            :aria-label="writable && !editing ? t(`ui.noteEditor.editNote`) : undefined"
            :class="writable && !editing ? `cursor-text` : ``"
            @click="pressToWrite"
            @keydown.enter="keyToWrite"
            @focusout="leave"
        >
            <div v-if="editing" class="px-4 py-3" @keydown.esc.prevent="escape">
                <MarkdownDocument
                    ref="doc"
                    v-model="source"
                    editable
                    save="auto"
                    :stored="raw"
                    :saving="saving"
                    :label="t(`ui.noteEditor.note2`)"
                    :placeholder="t(`ui.noteEditor.writeNote`)"
                    @save="emit(`save`, true)"
                />
            </div>
            <slot v-else>
                <MarkdownDocument :model-value="source" :label="t(`ui.noteEditor.note2`)" class="px-4 py-3" />
            </slot>
        </div>
    </ScrollFrame>
</template>
