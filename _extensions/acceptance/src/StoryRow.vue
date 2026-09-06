<script setup lang="ts">
import { errorMessage } from "@intentic/base/errors";
import { Button, Checkbox, DisclosureRow, Icon, MarkdownDocument, Notice, noticeOf, StatusBadge, type StatusVariant } from "@intentic/extension-ui";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { criteriaOf, type Story } from "./stories";

/* ONE STORY, and the row IS the editor.
 *
 * This used to be a modal. A modal is the wrong shape for the thing being done here: writing acceptance criteria
 * is comparative work (does this promise overlap the story above it? did we already say this?), it is done in
 * small increments over weeks, and it is abandoned halfway more often than it is finished. A dialog answers none
 * of that: it hides the list you are writing against, it asks for everything at once, and it makes "add one more
 * criterion I just thought of" a four-click errand.
 *
 * So: expand in place, and SAVE AS YOU TYPE. There is no Save button and no Cancel, because the file in the repo
 * is the story: the same as editing it in the workspace tree, which nobody expects to be transactional either.
 *
 * IT IS THE FILE, NOT A FORM OF ITS PARTS, and that is what changed here. This panel used to take the story
 * apart — a heading field, a narrative field, a list of criterion rows with their own Enter/Backspace/arrow
 * handling — and put it back together into markdown on every keystroke. It read beautifully and it could only
 * ever edit files of exactly that shape: anything the parser did not recognise (a table of fixtures, a fenced
 * setup block, a note under one criterion, a second heading) was silently dropped the moment somebody opened
 * the row. The story is a markdown file in the repo, so it is edited as one, on <MarkdownDocument>, the same
 * surface as a file in the workspace tree and a skill and the safety policy.
 *
 * WHAT THE HAND-ROLLED LIST BOUGHT, AND WHERE IT WENT. "Enter opens the next one" was the reason for all of it,
 * and it is now the surface's own (`continueList`): Enter on a list item opens the next item, Enter on an empty
 * one ends the list, and a `- [ ]` continues as an unticked box. Nothing else that layer did was specific to a
 * story — Backspace on an empty item, the arrows walking the list, Tab nesting one — and all of it now works on
 * every markdown document in the product instead of on this one.
 *
 * WHAT THE FILE IS READ FOR IS UNCHANGED. `criteriaOf` still finds `## Acceptance criteria` and counts what is
 * under it, for the collapsed row's tally and for the run's grading. Only the editor changed.
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
    // Just created by the composer: open with the caret at the end, so the author keeps typing.
    autofocus?: boolean;
    // Ticked for the next run. Note that an untouched list runs ALL of its stories: see RunControls, so an unticked
    // row is not an excluded one until something else in the list is ticked.
    selected: boolean;
    save: (input: { readonly path: string; readonly markdown: string }) => Promise<void>;
    remove: (path: string) => Promise<void>;
}>();
const emit = defineEmits<{ toggle: []; select: [boolean]; run: [] }>();

const HINT =
    `# Sign in with an email address\n\n` +
    `As a returning visitor, I want to sign in with my email and password so that I reach my own workspace.\n\n` +
    `What the user is trying to do, where they start, and what counts as success. Handed to the agent verbatim: a ` +
    `test login or a fixture it needs belongs here.\n\n` +
    `## Acceptance criteria\n\n` +
    `- A wrong password shows an error and keeps the email field filled\n`;

const draft = ref(``);
// What the file said when this row last wrote it (or last read it). Handed to the document surface, which is
// what decides from it whether anything needs saving — so opening a story to READ it never dirties the file.
const written = ref(``);
// Has the file's text actually arrived. The document is not drawn until it has, because a surface that mounts
// empty and fills a moment later has already put the caret in the wrong place and shown a blank page for a
// file that has words in it.
const loaded = ref(false);
const saving = ref(false);
const failure = ref<string | undefined>(undefined);
const confirmRemove = ref(false);

// What the collapsed row counts, and what the run is graded against. One function over the file, whichever copy
// of it is currently the truth.
const authored = computed<number>(() => criteriaOf(expanded ? draft.value : content).length);
/* A brand-new story: the caret goes where the composer left off, which is the empty bullet `newStoryMarkdown`
 * ends with. Trimmed, because the file ends in a newline and the caret belongs after the `- ` rather than on
 * the blank line under it. Read once, when the surface mounts, which is why nothing may mount before the text
 * has landed. */
const caretAt = computed<number | undefined>(() => (autofocus === true ? draft.value.trimEnd().length : undefined));

/* WHEN THE ROW OPENS, AND AGAIN IF THE TEXT ARRIVES AFTER IT DID. The second half is the composer's path: it
 * writes the new file, opens the row, and the refetch carrying that file's text lands a moment later, so a
 * loader that only ran on expand would show a blank document over a story that has a title in it.
 *
 * NEVER OVER AN EDIT IN PROGRESS, which is what `draft !== written` says: the refetch this row's OWN save
 * triggers arrives while somebody is still typing, and must not yank the text out from under the cursor. */
watch(
    [() => expanded, () => content],
    ([open, text]) => {
        if (!open) {
            return;
        }
        confirmRemove.value = false;
        const next = text ?? ``;
        if (draft.value !== written.value || next === written.value) {
            return;
        }
        failure.value = undefined;
        draft.value = next;
        written.value = next;
        loaded.value = next !== ``;
    },
    { immediate: true },
);

const commit = async (markdown: string): Promise<void> => {
    // A story with no title would write `# ` over a file that has one, so an empty document is a pause, not a
    // save. The rest of the file is whatever the author typed, and none of it is this row's to normalise.
    if (markdown.trim() === ``) {
        return;
    }
    saving.value = true;
    try {
        await save({ path: story.path, markdown });
        written.value = markdown;
        failure.value = undefined;
    } catch (error) {
        failure.value = errorMessage(error);
    } finally {
        saving.value = false;
    }
};

const discard = async (): Promise<void> => {
    failure.value = undefined;
    try {
        await remove(story.path);
    } catch (error) {
        failure.value = errorMessage(error);
        confirmRemove.value = false;
    }
};

// Closing the panel, navigating away, or the whole view unmounting all reach the DOCUMENT's own flush, which is
// what writes the last sentence. This only stops a row that is mid-save from reporting into a dead component.
onBeforeUnmount(() => (saving.value = false));
</script>

<template>
    <!-- THE DOCUMENT IS A `drawer`: what opens is a place to write in, with its own heading and its own margins,
         not a fact hanging off the row's title. -->
    <DisclosureRow density="compact" body="drawer" :open="expanded" @update:open="emit(`toggle`)">
        <!-- The tick sits OUTSIDE the row's button rather than inside it: a checkbox nested in a button is both
             invalid and unusable (every attempt to tick would expand the row instead), and the two gestures are
             genuinely different: one narrows the next run, the other opens the story to write. `#before` is
             <DisclosureRow>'s name for that column, and it rides inside the row's tint so the whole line still
             lights up as one row.

             SMALL AND QUIET, because this column is as long as the list and almost none of it is ever ticked
             (empty means all, see RunControls): at Aura's full size and ring the narrowing control was the
             first thing the eye found on a page whose subject is the promises beside it. Pointing at the row
             brings its tick back to full contrast: see `ui-checkbox-quiet` for what that state is paying for. -->
        <template #before>
            <Checkbox
                :model-value="selected"
                binary
                size="small"
                class="ui-checkbox-quiet ml-4"
                :aria-label="`Run ${story.title}`"
                @update:model-value="emit(`select`, $event === true)"
            />
        </template>

        <template #title>
            <!-- Open, the document below carries the title, so the row identifies the FILE instead of repeating it. -->
            <span v-if="expanded" class="block min-w-0 truncate font-mono text-2xs font-normal text-subtle">{{ story.path }}</span>
            <!-- ONE STEP OFF WHITE, AND FULL WHITE UNDER THE POINTER: the app's own weight for a long list of
                 rows read by scanning (the file tree, the search results, the commit list all sit here). Twenty
                 rows whose entire ink is one sentence-long title each read as a wall at full content white, and
                 nothing in them stands out: least of all the row carrying a failed verdict. `muted` is the step
                 past this one and it is the wrong one: that is the weight of a FACT ABOUT a row, and a list
                 whose subject is set in it looks switched off. -->
            <span v-else class="block min-w-0 truncate font-normal text-content/80 group-hover:text-content">{{ story.title }}</span>
        </template>

        <!-- THE VERDICT FIRST, THEN THE COUNT, and the count in a fixed cell, the runs list's own
             trailing-column recipe. Ordered the other way round they both moved: the count sat at the
             right edge on a story nothing had tested and 70px in on one that had, so a list where most
             rows carry no badge yet had a ragged right margin and no badge column to scan down. -->
        <template #meta>
            <StatusBadge v-if="status" :variant="status.variant" :label="status.label" size="xs" />
            <!-- Criteria are the story's readiness, not its correctness: a story with none still runs, nobody
                 has just said yet what "done" means for it. Stated quietly for that reason: a fresh workspace
                 that shouted a warning on every row would be teaching people to ignore the colour. -->
            <span class="w-20 shrink-0 text-right">{{ authored === 0 ? `no criteria` : `${authored} criteria` }}</span>
        </template>

        <!-- Its own generous margins rather than the list's row padding, and a measured column: a criterion in an
             unbounded 72rem card ran past 150 characters a line, well past where the eye loses the start of the
             next one. 68ch is prose.css's own reading measure, set here because how wide the words get is a fact
             about this panel and not about the document. -->
        <template #below>
            <!-- Escape closes the row, and closing it unmounts the document, whose own flush is what writes the
                 last sentence. So the key that leaves is never the key that loses anything. -->
            <div class="py-2 sm:px-2" @keydown.esc="emit(`toggle`)">
                <div class="max-w-read px-2" style="--prose-measure: 68ch">
                    <p v-if="!loaded" class="flex items-center gap-2 py-6 text-2xs text-subtle">
                        <Icon name="spinner" spin class="text-xs" />
                        Reading {{ story.path.split(`/`).pop() }}…
                    </p>
                    <MarkdownDocument
                        v-else
                        v-model="draft"
                        editable
                        save="auto"
                        :stored="written"
                        :saving="saving"
                        :caret-at="caretAt"
                        :label="story.path"
                        :placeholder="HINT"
                        class="min-h-64"
                        @save="commit"
                    >
                        <template #note>
                            <template v-if="authored === 0">
                                With no <code>## Acceptance criteria</code>, the agent reads checkable claims out of your prose instead, which works,
                                but then the report grades itself against its own reading rather than against what you promised.
                            </template>
                            <template v-else>One verdict per criterion, in the order you wrote them. Enter opens the next one.</template>
                        </template>
                    </MarkdownDocument>

                    <Notice v-if="failure" :of="noticeOf(failure)" class="mt-4" />
                </div>

                <!-- OUTSIDE the column: the document is measured, the toolbar under it is not. Kept inside the 68ch
                     rule, these buttons floated in the middle of a 1100px card with empty surface either side,
                     which reads as a stray cluster rather than as the panel's actions. -->
                <div class="mt-6 flex items-center justify-end gap-2 border-t border-line/60 pt-3">
                    <!-- Narrows the run to this story; the run pill then says what it will do and does it.
                         Not a second way to start a run: one gate, one button, and this is how you aim at it. -->
                    <Button label="Run only this" size="small" severity="secondary" @click="emit(`run`)">
                        <template #icon><Icon name="play" /></template>
                    </Button>
                    <!-- Delete asks once, in place: a story is a file in the repo, and the ask costs less than
                         a restore from git for someone who clicked the wrong row. -->
                    <Button v-if="!confirmRemove" size="small" severity="danger" label="Delete" @click="confirmRemove = true" />
                    <Button v-else size="small" severity="danger" :label="`Delete ${story.path.split(`/`).pop()}?`" @click="discard" />
                </div>
            </div>
        </template>
    </DisclosureRow>
</template>
