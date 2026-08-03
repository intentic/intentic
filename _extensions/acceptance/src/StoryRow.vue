<script setup lang="ts">
import { Button, Checkbox, cmp, Icon, ProseField, StatusBadge, type StatusVariant } from "@intentic/extension-ui";
import { computed, nextTick, onBeforeUnmount, ref, watch } from "vue";
import { criteriaOf, narrativeOf, type Story, storyMarkdown } from "./stories";

/* ONE STORY — and the row IS the editor.
 *
 * This used to be a modal. A modal is the wrong shape for the thing being done here: writing acceptance criteria
 * is comparative work (does this promise overlap the story above it? did we already say this?), it is done in
 * small increments over weeks, and it is abandoned halfway more often than it is finished. A dialog answers none
 * of that — it hides the list you are writing against, it asks for everything at once, and it makes "add one more
 * criterion I just thought of" a four-click errand.
 *
 * So: expand in place, and SAVE AS YOU TYPE. There is no Save button and no Cancel, because the file in the repo
 * is the story — the same as editing it in the workspace tree, which nobody expects to be transactional either.
 * A debounce plus a comparison against what was last written means an author who opens a story to READ it never
 * dirties the file, and a fresh, unedited row never triggers a write.
 *
 * IT IS SET AS A DOCUMENT, NOT AS A FORM, and that is a readability decision before it is an aesthetic one. This
 * panel is the only place in the app where someone WRITES paragraphs, and it was the only place typeset below the
 * design system's own floor: the narrative — the one true prose on the surface — was 12px MONO, a typeface the
 * system reserves for code and which reads optically larger, so it was set a step down again to compensate for a
 * job it should not have had. See prose.css: 0.875rem is the floor for text read in paragraphs, ~1.7 is its
 * leading, and a measure is mandatory on a surface that stretches (this page is 72rem — unbounded, a criterion
 * ran past 150 characters a line, well past where the eye loses the start of the next one).
 *
 * So everything read in sentences is sans, at the floor, at 1.7, inside a 68ch column, in full content colour;
 * mono survives only where it is an identifier (the path, the criterion numbers). And the fields are BORDERLESS
 * and as tall as what has been typed into them — <ProseField>, which is the recipe this panel worked out and
 * which now lives in the kit, because the workflow designer's step prompt is the same job and would otherwise
 * have been a second copy of a thing whose failure mode (a size replica that disagrees with its field) is
 * invisible until it clips somebody's last paragraph. The mirror of the artifact, in the artifact's own order:
 * heading, prose, `## Acceptance criteria`, the list.
 *
 * CRITERIA ARE EDITED AS A LIST, not as a form: Enter opens the next one, Backspace on an empty one removes it,
 * the arrows walk them from the ends. That is what the content actually is — a checklist someone adds to as they
 * think — and every criterion typed without reaching for the mouse is one more promise that gets written down
 * instead of being left in someone's head.
 *
 * The title still never moves the file. Editing renames the heading and leaves `docs/user-stories/01-sign-in.md`
 * exactly where git, the ordering prefix and every link to it expect it. */

const { story, content, expanded, status, autofocus, selected, save, remove } = defineProps<{
    story: Story;
    // The file's text as last read. Loaded into the draft when the row opens, and never afterwards: a refetch
    // triggered by this row's own save must not yank the text out from under the cursor.
    content?: string | undefined;
    expanded: boolean;
    // What the latest run said about this story, when it covered it.
    status?: { readonly label: string; readonly variant: StatusVariant } | undefined;
    // Just created by the composer: open on the first empty criterion so the author keeps typing.
    autofocus?: boolean;
    // Ticked for the next run. Note that an untouched list runs ALL of its stories — see RunControls — so an unticked
    // row is not an excluded one until something else in the list is ticked.
    selected: boolean;
    save: (input: { readonly path: string; readonly markdown: string }) => Promise<void>;
    remove: (path: string) => Promise<void>;
}>();
const emit = defineEmits<{ toggle: []; select: [boolean]; run: [] }>();

// Long enough that a sentence is written as one save rather than as fifteen, short enough that leaving the row is
// never a race with the timer.
const SAVE_AFTER_MS = 700;

/* The hints are constants rather than literals in the template because <ProseField> mirrors whatever the field
 * is DISPLAYING to work out its height, and for an empty field that is its placeholder — one string, read by
 * the size replica and by the placeholder both. */
const TITLE_HINT = `Sign in with an email address`;
const NARRATIVE_HINT =
    `As a returning visitor, I want to sign in with my email and password so that I reach my own workspace.\n\n` +
    `What the user is trying to do, where they start, and what counts as success. Handed to the agent verbatim — a ` +
    `test login or a fixture it needs belongs here.`;
const CRITERION_HINT = `A wrong password shows an error and keeps the email field filled`;
const NEXT_HINT = `and then…`;

const title = ref(``);
const narrative = ref(``);
const criteria = ref<string[]>([]);
const inputs = ref<Record<number, InstanceType<typeof ProseField> | undefined>>({});
const state = ref<`clean` | `dirty` | `saving` | `saved`>(`clean`);
const failure = ref<string | undefined>(undefined);
const confirmRemove = ref(false);

// The markdown as last written to disk — the baseline every autosave compares against, so nothing is written
// twice and reading is never writing. Not a ref: no template reads it.
let written = ``;
let timer: ReturnType<typeof setTimeout> | undefined;

const markdown = computed<string>(() => storyMarkdown({ title: title.value, narrative: narrative.value, criteria: criteria.value }));
// What the collapsed row counts, and what the run is graded against. Blank rows are the editor's, not the file's.
const authored = computed<number>(() => (expanded ? criteria.value.filter((text) => text.trim() !== ``).length : criteriaOf(content).length));

const focusAt = (index: number): void => {
    const at = Math.min(Math.max(index, 0), criteria.value.length - 1);
    void nextTick(() => {
        const input = inputs.value[at]?.field;
        input?.focus();
        input?.setSelectionRange(input.value.length, input.value.length);
    });
};

const insertAfter = (index: number): void => {
    criteria.value = [...criteria.value.slice(0, index + 1), ``, ...criteria.value.slice(index + 1)];
    focusAt(index + 1);
};

// Backspace at the start of an empty criterion removes it, the way it does in every checklist. The last row is
// kept: an editor with nothing to type in is a dead end.
const shrink = (index: number, event: KeyboardEvent): void => {
    if (criteria.value[index] !== `` || criteria.value.length === 1) {
        return;
    }
    event.preventDefault();
    criteria.value = criteria.value.filter((_, at) => at !== index);
    focusAt(index - 1);
};

/* Up and Down walk the list — but only from the ENDS of a criterion, so the arrows still move the caret through
 * one that wrapped onto three lines. Position, not a guess about visual rows: the caret is at 0 or at the last
 * character, or the key belongs to the field. */
const walk = (index: number, event: KeyboardEvent, step: -1 | 1): void => {
    const el = event.target as HTMLTextAreaElement;
    const atEdge = step === -1 ? el.selectionStart === 0 : el.selectionEnd === el.value.length;
    if (!atEdge || el.selectionStart !== el.selectionEnd) {
        return;
    }
    event.preventDefault();
    focusAt(index + step);
};

const drop = (index: number): void => {
    criteria.value = criteria.value.length === 1 ? [``] : criteria.value.filter((_, at) => at !== index);
};

const load = (): void => {
    confirmRemove.value = false;
    failure.value = undefined;
    title.value = story.title;
    narrative.value = narrativeOf(content);
    const existing = criteriaOf(content);
    // An empty row rather than an empty state: the invitation to write one IS the input. storyMarkdown drops
    // blank rows, so this can never dirty a story that has none.
    criteria.value = existing.length > 0 ? [...existing] : [``];
    written = markdown.value;
    state.value = `clean`;
    if (autofocus === true) {
        focusAt(0);
    }
};

const flush = async (): Promise<void> => {
    clearTimeout(timer);
    const next = markdown.value;
    // A story with no title would write `# ` over a file that has one, so an empty title is a pause, not a save.
    if (next === written || title.value.trim() === ``) {
        return;
    }
    state.value = `saving`;
    try {
        await save({ path: story.path, markdown: next });
        written = next;
        failure.value = undefined;
        state.value = markdown.value === written ? `saved` : `dirty`;
    } catch (error) {
        failure.value = error instanceof Error ? error.message : String(error);
        state.value = `dirty`;
    }
};

const discard = async (): Promise<void> => {
    failure.value = undefined;
    try {
        await remove(story.path);
    } catch (error) {
        failure.value = error instanceof Error ? error.message : String(error);
        confirmRemove.value = false;
    }
};

watch(
    () => expanded,
    (open) => (open ? load() : void flush()),
    { immediate: true },
);

watch(markdown, (next) => {
    clearTimeout(timer);
    if (!expanded) {
        return;
    }
    state.value = next === written ? `clean` : `dirty`;
    if (state.value === `dirty`) {
        timer = setTimeout(() => void flush(), SAVE_AFTER_MS);
    }
});

// Closing the panel, navigating away, or the whole view unmounting all reach here — the debounce must never be
// what loses the last sentence someone typed.
onBeforeUnmount(() => void flush());
</script>

<template>
    <div>
        <!-- The tick sits OUTSIDE the row's button rather than inside it: a checkbox nested in a button is both
             invalid and unusable (every attempt to tick would expand the row instead), and the two gestures are
             genuinely different — one narrows the next run, the other opens the story to write. The hover tint
             rides the wrapper so the whole line still lights up as one row. -->
        <div class="flex w-full items-center gap-3 pl-4 hover:bg-overlay" :class="expanded && `bg-overlay`">
            <Checkbox :model-value="selected" binary :aria-label="`Run ${story.title}`" @update:model-value="emit(`select`, $event === true)" />
            <button
                type="button"
                class="flex min-w-0 flex-1 cursor-pointer items-center gap-3 py-2.5 pr-4 text-left"
                :aria-expanded="expanded"
                @click="emit(`toggle`)"
            >
                <Icon :name="expanded ? `chevron-down` : `chevron-right`" class="shrink-0 text-subtle" />
                <!-- Open, the heading below is the title, so the row identifies the FILE instead of repeating it. -->
                <span v-if="expanded" class="min-w-0 flex-1 truncate font-mono text-2xs text-subtle">{{ story.path }}</span>
                <span v-else class="min-w-0 flex-1 truncate text-sm text-content">{{ story.title }}</span>
                <!-- Criteria are the story's readiness, not its correctness: a story with none still runs, nobody
                     has just said yet what "done" means for it. Stated quietly for that reason — a fresh workspace
                     that shouted a warning on every row would be teaching people to ignore the colour. -->
                <span class="shrink-0 text-2xs text-subtle">{{ authored === 0 ? `no criteria` : `${authored} criteria` }}</span>
                <StatusBadge v-if="status" :variant="status.variant" :label="status.label" size="xs" />
            </button>
        </div>

        <!-- THE DOCUMENT. Its own generous margins rather than the list's row padding, a measured column, and
             `cursor-text` over the whole of it: the page under the words is what says "write here", now that no
             field draws a box to say it. -->
        <div v-if="expanded" class="cursor-text border-t border-line/60 bg-canvas px-4 py-6 sm:px-6">
            <!-- `text-sm` on the COLUMN, not just on the fields inside it: `ch` resolves against the element's own
                 font-size, so a cap set here while the div still inherited the 16px root made 68ch mean 686px —
                 101 characters of 14px prose, past the ~90 where the eye stops finding the next line. Set in the
                 prose's own size it means what it says. -->
            <div class="flex max-w-[68ch] flex-col px-2 text-sm">
                <!-- The `# Heading` this writes, at the size a heading is. It was `text-sm font-medium` — the same
                     size as the collapsed row it replaces, so opening a story changed nothing about how it read. -->
                <ProseField
                    v-model="title"
                    variant="heading"
                    :placeholder="TITLE_HINT"
                    class="-mx-2"
                    @keydown.enter.prevent="focusAt(0)"
                    @keydown.esc="emit(`toggle`)"
                />

                <!-- The story's prose, directly under its heading and unlabelled — in the file it is simply the
                     body, and a form label over it would be describing what the words already are. -->
                <ProseField v-model="narrative" :placeholder="NARRATIVE_HINT" class="-mx-2 mt-3 min-h-24" @keydown.esc="emit(`toggle`)" />

                <!-- `## Acceptance criteria`, set as the subheading it becomes rather than as a form's field
                     label: the panel is a picture of the file, and this line exists in the file. -->
                <div class="mt-5 flex items-baseline justify-between border-t border-line/60 pt-4">
                    <h3 class="text-sm font-semibold text-content">Acceptance criteria</h3>
                    <span class="text-2xs text-subtle">one verdict each, in this order</span>
                </div>
                <div class="mt-2 flex flex-col">
                    <div v-for="(text, index) in criteria" :key="index" class="group flex items-start gap-1">
                        <!-- The same line box as the text it numbers — same size, same leading, same padding — so
                             the digit sits ON the first baseline. Smaller, it rendered as a superscript. It
                             recedes by colour instead, which costs no alignment. -->
                        <span class="w-5 shrink-0 py-1 text-right text-sm leading-[1.7] tabular-nums text-subtle">{{ index + 1 }}</span>
                        <!-- Bound through the loop's own value rather than as `v-model="criteria[index]"`: an
                             indexed read is `string | undefined`, and the field's model is a string. -->
                        <ProseField
                            :ref="(el) => (inputs[index] = el as InstanceType<typeof ProseField>)"
                            :model-value="text"
                            @update:model-value="criteria[index] = $event"
                            :placeholder="index === 0 ? CRITERION_HINT : NEXT_HINT"
                            class="min-w-0 flex-1"
                            @keydown.enter.prevent="insertAfter(index)"
                            @keydown.backspace="shrink(index, $event)"
                            @keydown.up="walk(index, $event, -1)"
                            @keydown.down="walk(index, $event, 1)"
                            @keydown.esc="emit(`toggle`)"
                        />
                        <!-- Quiet until the row is under the pointer or holds the caret. Fifteen ×'s down the
                             margin is fifteen invitations to delete a promise, printed beside every one of them. -->
                        <button
                            type="button"
                            class="mt-0.5 shrink-0 cursor-pointer p-1 text-subtle opacity-0 group-focus-within:opacity-100 group-hover:opacity-100 hover:text-danger focus-visible:opacity-100"
                            aria-label="Remove criterion"
                            @click="drop(index)"
                        >
                            <Icon name="times" />
                        </button>
                    </div>
                </div>
                <p class="mt-2 pl-8 text-2xs text-subtle">
                    Enter opens the next one.
                    <template v-if="authored === 0">
                        With none, the agent reads checkable claims out of your prose instead — which works, but then the report grades itself against
                        its own reading rather than against what you promised.
                    </template>
                </p>

                <div v-if="failure" :class="cmp.alertDanger(`mt-4`)">{{ failure }}</div>
            </div>

            <!-- OUTSIDE the column: the document is measured, the toolbar under it is not. Kept inside the 68ch
                 rule, these buttons floated in the middle of a 1100px card with empty surface either side, which
                 reads as a stray cluster rather than as the panel's actions. -->
            <div class="mt-6 flex items-center gap-3 border-t border-line/60 pt-3">
                <!-- Autosave is only trustworthy if it says so. Silence here would make a story authored and
                     closed in six seconds feel like a story that was lost. -->
                <span class="text-2xs" :class="state === `saved` ? `text-success` : `text-subtle`">{{
                    state === `saving` ? `Saving…` : state === `dirty` ? `Unsaved` : state === `saved` ? `Saved` : ``
                }}</span>
                <div class="ml-auto flex items-center gap-2">
                    <!-- Narrows the run to this story; the run pill then says what it will do and does it.
                         Not a second way to start a run — one gate, one button, and this is how you aim at it. -->
                    <Button label="Run only this" size="small" severity="secondary" @click="emit(`run`)">
                        <template #icon><Icon name="play" /></template>
                    </Button>
                    <!-- Delete asks once, in place: a story is a file in the repo, and the ask costs less than
                         a restore from git for someone who clicked the wrong row. -->
                    <Button v-if="!confirmRemove" size="small" severity="danger" label="Delete" @click="confirmRemove = true" />
                    <Button v-else size="small" severity="danger" :label="`Delete ${story.path.split(`/`).pop()}?`" @click="discard" />
                </div>
            </div>
        </div>
    </div>
</template>
