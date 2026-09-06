<!-- THE ONE SURFACE A MARKDOWN CONFIG IS AUTHORED ON, wherever in the product that happens.

     WHAT THIS REPLACES. Nine places in this app let somebody write a whole markdown document an agent then
     reads — the safety policy, the sandbox's system prompt, a persona's prompt, a skill, a knowledge note, an
     acceptance story, a file in the workspace, the memory files — and they had agreed on nothing. Five
     different ways of DISPLAYING the document (coloured source, a bare grey textarea five rows tall, rendered
     prose behind a Write/Preview pill, a form of separate fields, a `<pre>`), six different ways of OPENING an
     editor (always open, only in one mode, a pencil, a disclosure row, an app-wide Edit switch), four save
     policies and three vocabularies for saying which one you were under. The same file could look like source
     on one screen, like a form on another, and like a document on a third.

     SO THERE IS ONE COMPONENT AND IT OWNS ALL FOUR DECISIONS. A caller says what the document IS and where it
     lives; it does not get to say what writing markdown feels like, because that is not a per-screen question
     and every screen that answered it separately answered it differently.

     DISPLAYING IS ALWAYS THE RENDERED DOCUMENT. `md-prose`, the app's one prose engine, whether or not you can
     type into it. Nothing sits behind a Preview pill because there is nothing to preview: what is on screen IS
     what the agent will read.

     OPENING IS CLICKING THE WORDS. The caret lands where you clicked. No pencil, no mode, no widget swapped in
     with a flicker. That comes from <MarkdownDocumentSurface>, which is the same document rebuilt from its own
     source so the DOM's text IS the file, with the markup characters present and hidden until the caret enters
     the block holding them. Both halves carry `md-prose`, so switching between them moves nothing.

     SAVING IS ONE OF TWO POLICIES, AND THE DOCUMENT DECLARES IT. `auto` for a document that IS the file, where
     nobody expects a transaction (a story, a note, a file in the workspace); `explicit` for a document read at
     the START OF EVERY TURN, where a half-typed sentence going live 700ms after you type it is a hazard rather
     than a convenience (the safety policy, a system prompt, a skill). Two policies, one vocabulary, one Ctrl-S,
     one debounce, one flush on the way out — which is the part that stops being a nicety once somebody has
     written five paragraphs and closed the panel.

     WHAT IS ON DISK IS THE CALLER'S TO SAY (`stored`), not this component's to remember. Every call site
     already holds it — it is what each of their four hand-rolled `dirty` computeds compared against — and a
     second copy kept here would be a second thing to get out of step with another window's save.

     MOBILE FALLS BACK TO <CodeField>, and this component decides that, not the caller. `contenteditable` and a
     phone's keyboard, selection handles and autocorrect do not get along; a real <textarea> does. That is also
     the whole of why <CodeField> survives this change — it keeps the job it is actually right for.

     WHAT IT DOES NOT OWN is the frame. A header, a delete button, a notice about what this document governs:
     those differ per call site and belong to the caller. <NoteEditor> is one such frame, built on this. -->
<script setup lang="ts">
import { computed, onBeforeUnmount, ref, useSlots } from "vue";
import { useDevice } from "../composables/useDevice.js";
import type { MarkdownDecorator } from "../markdown/render.js";
import Button from "./Button.vue";
import CodeField from "./CodeField.vue";
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
    /** When this document gets written: see `markdownDocument.ts`, which is the whole of that decision. */
    save?: SavePolicy;
    /** The write is in flight. Drives the status line; the caller owns the request. */
    saving?: boolean;
    /**
     * The document as it stands on disk. What "unsaved" is measured against, and what a save that changed
     * nothing is compared to, so opening a document to READ it can never write it. Omit only where the caller
     * genuinely does not know (then nothing is ever reported as saved).
     */
    stored?: string;
    /**
     * The longest the document may be, where something downstream enforces one (the prompt routes cap at
     * 20,000 and the daemon refuses more). Reported as a count near the ceiling rather than as a hard
     * `maxlength`: a writing surface that silently stops accepting characters is one where a paste appears to
     * have worked and did not.
     */
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

/* THE DOCUMENT ITSELF is a model, so a caller seeds it, follows it and reads it back through one binding. The
 * editing surface is uncontrolled by design (it owns its DOM between renders) and reconciles a `source` that
 * arrives from elsewhere against what it is holding, so an echo of this component's own edit is a no-op there
 * and a document replaced from outside is laid out again. Nothing here has to arrange that. */
const doc = defineModel<string>({ required: true });

const { mobile } = useDevice();

/* WHEN THIS GETS WRITTEN is `markdownDocument.ts`, and it is a sidecar rather than sixty lines here because it
 * is the part with decisions in it: the debounce, the baseline comparison that keeps reading from writing, the
 * flush on the way out, and the one status vocabulary. A decision that can only be exercised by mounting a
 * `contenteditable` is a decision nobody exercises. */
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

// Closing a panel, changing a route and tearing down a view all arrive here as the same thing: the surface is
// going away, and under `auto` the last sentence is written on the way out.
onBeforeUnmount(leave);

/* THE COUNT, and only near the ceiling: a number that is always on screen is a number nobody reads, and one
 * that appears at 95% is the warning it was meant to be. Over the cap it goes red, because the save the
 * daemon is about to refuse has to be predictable from what is on screen. */
const NEAR = 0.95;
const count = computed(() => (maxChars !== undefined && doc.value.length >= maxChars * NEAR ? `${doc.value.length} / ${maxChars}` : undefined));
const over = computed(() => maxChars !== undefined && doc.value.length > maxChars);

/* Is there a row under the document at all. A read-only document has no draft to report on and no button to
 * press, and a bar drawn for it is an empty rule under every rendered note in the app. */
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
        <!-- THE SAME DOCUMENT, TWICE OVER, IN THE SAME TYPE. Reading is the app's one prose engine; writing is
             that document rebuilt from its own source so the caret has something true to stand in. Nothing
             about the switch is animated or measured, because with one set of type rules over both there is
             nothing to move. Neither sets a measure: `--prose-measure` is the caller's, and both obey it. -->
        <!-- `flex-1` on all three branches, so a caller that gives this a minimum height (a policy box, a note
             pane) hands that height to the DOCUMENT rather than to the column holding it. Without it an empty
             surface is one line tall inside a 16rem box and the words to click on are nowhere near the box. -->
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
        <!-- A phone gets the source field instead: `contenteditable` and a touch keyboard's selection handles,
             autocorrect and candidate list do not get along, and a real <textarea> does. Same file, same
             colours as everywhere else source is shown, and it writes through the same `onChange`, so the save
             policy above neither knows nor cares which half is on screen. -->
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

        <!-- WHY YOU CANNOT WRITE HERE, said where somebody would try it. Absent when the answer is obvious. -->
        <p v-if="readOnlyReason !== undefined && !editable" class="mt-2 text-2xs text-subtle">{{ readOnlyReason }}</p>

        <!-- THE FOOT: what the caller wants to say about this document on the left, what the app has to say
             about the draft on the right. One row, one order, every surface. Absent entirely when there is
             nothing to report and nothing to press, so a read-only document is not followed by an empty bar. -->
        <div v-if="foot" class="mt-2 flex flex-wrap items-center justify-between gap-x-3 gap-y-1">
            <span class="min-w-0 text-2xs text-subtle"><slot name="note" /></span>
            <span class="flex shrink-0 items-center gap-2">
                <span v-if="count !== undefined" class="text-2xs tabular-nums" :class="over ? `text-danger` : `text-muted`">{{ count }}</span>
                <span class="text-2xs" :class="status === `Saved` ? `text-success` : `text-subtle`">{{ status }}</span>
                <slot name="actions" />
                <!-- Under `explicit` the button is the only thing that writes, so it is always on screen to be
                     found rather than appearing when the document goes dirty: a control that materialises next
                     to the cursor is a control somebody presses by accident. Disabled says the same thing
                     without moving anything. `mousedown.prevent` keeps the caret in the document, so pressing
                     it does not blur the surface out from under the click that was landing on it. -->
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
