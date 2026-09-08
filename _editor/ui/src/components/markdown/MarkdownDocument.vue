<!--
    The one surface a markdown config is authored on, wherever in the product. Always displays as rendered prose, no preview toggle; the caret enters
    on click via <MarkdownDocumentSurface>. `stored` decides `auto` (saves silently) vs `explicit` (Ctrl-S) save policy; mobile falls back to
    <CodeField>.
-->
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, useSlots } from "vue";
import { useDevice } from "../../composables/useDevice.js";
import type { MarkdownDecorator } from "../../markdown/render.js";
import Button from "../primitives/Button.vue";
import CodeField from "../forms/CodeField.vue";
import Markdown from "./Markdown.vue";
import MarkdownDocumentSurface from "./MarkdownDocumentSurface.vue";
import { type SavePolicy, useSaveDraft } from "./markdownDocument.js";

const {
    editable = false,
    save: policy = `auto`,
    saving = false,
    placeholder = ``,
    label = `Document`,
    stored,
    maxChars,
    readOnlyReason,
    decorate,
    caretAt,
} = defineProps<{
    /** May this reader write to it at all. False renders the document and nothing else. */
    editable?: boolean;
    /** When this document gets written (see SavePolicy). */
    save?: SavePolicy;
    /** The write is in flight. Drives the status line; the caller owns the request. */
    saving?: boolean;
    /** The document on disk; what "unsaved" and a no-op save are measured against. Omit only if unknown. */
    stored?: string;
    /** Longest the document may be, if enforced downstream; shown near the ceiling, never a hard `maxlength`. */
    maxChars?: number;
    placeholder?: string;
    /** What a screen reader calls this document. */
    label?: string;
    /** Why it cannot be edited, when that is worth saying. Shown under the document. */
    readOnlyReason?: string;
    /** A pass over the rendered DOM before it lands: the app uses it to linkify file mentions. */
    decorate?: MarkdownDecorator;
    /** Where to put the caret when the editing surface mounts, as a source offset. */
    caretAt?: number;
}>();

const emit = defineEmits<{
    /** The document changed. Fires as it is typed; `save` is what means "write this". */
    change: [value: string];
    /** Write this text. Debounced under `auto`, from the button or Ctrl-S under `explicit`. */
    save: [value: string];
}>();

// A model: the caller seeds, follows and reads it through one binding; the surface reconciles edits itself.
const doc = defineModel<string>({ required: true });

const { mobile } = useDevice();

// Save timing lives in markdownDocument.ts: none of its decisions require mounting a `contenteditable`.
const { dirty, status, touched, commit, leave } = useSaveDraft({
    policy: () => policy,
    text: () => doc.value,
    stored: () => stored,
    saving: () => saving,
    write: (text) => emit(`save`, text),
});

const onChange = (value: string): void => {
    doc.value = value;
    emit(`change`, value);
    touched();
};

// Whether the reader is actually typing into it: the host's permission, and a surface that can take a caret.
const writing = computed(() => editable && !mobile.value);

// Panel close, route change, unmount all arrive here as one thing, flushing the last sentence under `auto`.
onBeforeUnmount(leave);

// Count shown only near the ceiling, since an always-visible number goes unread; red once over the cap.
const NEAR = 0.95;
const count = computed(() => (maxChars !== undefined && doc.value.length >= maxChars * NEAR ? `${doc.value.length} / ${maxChars}` : undefined));
const over = computed(() => maxChars !== undefined && doc.value.length > maxChars);

// Whether the foot row is shown at all; a read-only document has nothing to report and no button to press.
const slots = useSlots();
const foot = computed(
    () => editable && (status.value !== `` || count.value !== undefined || policy === `explicit` || slots[`note`] !== undefined || slots[`actions`] !== undefined),
);

const surface = ref<InstanceType<typeof MarkdownDocumentSurface>>();
/** The text as the surface currently holds it, which is ahead of the model only mid-keystroke. */
const text = (): string => surface.value?.text() ?? doc.value;

defineExpose({ text, commit, focus: (): void => surface.value?.focus(), dirty, status });
</script>

<template>
    <div class="flex min-w-0 flex-col">
        <!--
            Same document, twice over, in the same type rules, so switching between reading and writing moves nothing
            and neither sets its own measure.
        -->
        <!--
            `flex-1` on all three branches, so a caller's minimum height goes to the document, not the column holding
            it.
        -->
        <MarkdownDocumentSurface
            v-if="writing"
            ref="surface"
            class="min-w-0 flex-1"
            :source="doc"
            :caret-at="caretAt"
            :aria-label="label"
            @change="onChange"
            @save="commit"
        />
        <!--
            Phone gets the source field instead: `contenteditable` fights a touch keyboard's selection and autocorrect;
            writes through the same `onChange` either way.
        -->
        <CodeField
            v-else-if="editable"
            :model-value="doc"
            lang="markdown"
            :placeholder="placeholder"
            :aria-label="label"
            class="min-w-0 flex-1"
            @update:model-value="onChange"
            @keydown.ctrl.s.prevent="commit"
            @keydown.meta.s.prevent="commit"
        />
        <!-- Nothing to type into: the document, or a sentence rather than an empty pane. -->
        <Markdown v-else-if="doc.trim() !== ``" :source="doc" :decorate="decorate" class="min-w-0 flex-1" />
        <p v-else class="flex-1 py-2 text-xs text-subtle">{{ placeholder }}</p>

        <!-- Why you cannot write here, said where somebody would try it; absent when the answer is obvious. -->
        <p v-if="readOnlyReason !== undefined && !editable" class="mt-2 text-2xs text-subtle">{{ readOnlyReason }}</p>

        <!--
            Caller's note on the left, the app's draft status on the right, one row for every surface; absent entirely
            when there's nothing to say.
        -->
        <div v-if="foot" class="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <span class="min-w-0 text-2xs text-subtle"><slot name="note" /></span>
            <span class="flex shrink-0 items-center gap-2">
                <span v-if="count !== undefined" class="text-2xs tabular-nums" :class="over ? `text-danger` : `text-muted`">{{ count }}</span>
                <span class="text-2xs" :class="status === `Saved` ? `text-success` : `text-subtle`">{{ status }}</span>
                <slot name="actions" />
                <!--
                    Always on screen under `explicit`, not appearing on dirty, since a control that materializes gets
                    pressed by accident; disabled instead. `mousedown.prevent` keeps the caret from blurring out before
                    the click lands.
                -->
                <Button
                    v-if="policy === `explicit`"
                    label="Save"
                    size="small"
                    :disabled="!dirty || saving"
                    :loading="saving"
                    @mousedown.prevent
                    @click="commit"
                />
            </span>
        </div>
    </div>
</template>
