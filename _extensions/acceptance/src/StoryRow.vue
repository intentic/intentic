<script setup lang="ts">
import { errorMessage } from "@intentic/base/errors";
import { Button, Checkbox, DisclosureRow, Icon, MarkdownDocument, Notice, noticeOf, StatusBadge, type StatusVariant } from "@intentic/extension-ui";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { criteriaOf, type Story } from "./stories";

// The row is the editor, not a modal: expand in place, save as you type, no Save/Cancel, since the file in the repo is
// the story. Edited as raw markdown on <MarkdownDocument>, not a form of parsed parts, which silently dropped anything
// it didn't recognize. `criteriaOf` still counts `## Acceptance criteria`; editing only ever renames the heading, never
// moves the file.

const { story, content, expanded, status, autofocus, selected, save, remove } = defineProps<{
    story: Story;
    // The file's text as last read, loaded into the draft only when the row opens, so this row's own save-triggered
    // refetch never yanks text from under the cursor.
    content?: string | undefined;
    expanded: boolean;
    // What the latest run said about this story, when it covered it.
    status?: { readonly label: string; readonly variant: StatusVariant } | undefined;
    // Just created by the composer: opens with the caret at the end, so the author keeps typing.
    autofocus?: boolean;
    // Ticked for the next run; an untouched list runs everything (RunControls), so unticked isn't excluded until
    // something else is ticked.
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
// What the file said when this row last wrote or read it; the document surface diffs against this to decide if anything
// needs saving, so reading a story never dirties it.
const written = ref(``);
// Whether the file's text has actually arrived; the document doesn't render until it has, or the caret lands wrong and
// a non-empty file flashes blank.
const loaded = ref(false);
const saving = ref(false);
const failure = ref<string | undefined>(undefined);
const confirmRemove = ref(false);

// What the collapsed row counts and the run is graded against, over whichever copy of the file is currently the truth.
const authored = computed<number>(() => criteriaOf(expanded ? draft.value : content).length);
// For a brand-new story, the caret goes after the empty bullet newStoryMarkdown ends with (trimmed past the trailing
// newline); read once, when the surface mounts.
const caretAt = computed<number | undefined>(() => (autofocus === true ? draft.value.trimEnd().length : undefined));

// Loads on expand, and again if the text arrives late (the composer's just-created path); never over an edit in
// progress (`draft !== written`), since this row's own save triggers the refetch that would otherwise land mid-type.
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
    // An empty document is a pause, not a save, since a blank title would overwrite an existing file's heading.
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

// Closing, navigating away, or unmounting all reach the document's own flush first; this only stops a mid-save row from
// reporting into a dead component.
onBeforeUnmount(() => (saving.value = false));
</script>

<template>
    <!-- The document opens as a `drawer`: its own heading and margins, not a fact hanging off the row's title. -->
    <DisclosureRow density="compact" body="drawer" :open="expanded" @update:open="emit(`toggle`)">
        <!--
            Outside the row's button (`#before`): a checkbox nested in one is invalid and unusable, and ticking (narrows the run) differs from
            opening (writes the story). Small and quiet by default, since almost none of this column is ever ticked; full contrast returns on hover.
        -->
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
            <!-- Open, the document below already carries the title, so the row shows the file path instead of repeating it. -->
            <span v-if="expanded" class="block min-w-0 truncate font-mono text-2xs font-normal text-subtle">{{ story.path }}</span>
            <!--
                One step off white, full white on hover: the app's own weight for a scanned list (file tree, search, commits), so a row carrying a
                failed verdict still stands out. `muted` reads as a fact about a row, not its subject.
            -->
            <span v-else class="block min-w-0 truncate font-normal text-content/80 group-hover:text-content">{{ story.title }}</span>
        </template>

        <!--
            Verdict before the count, count in a fixed-width cell, this list's own trailing-column recipe; reversed, the count's position moved with
            whether a badge was present, giving the column a ragged edge.
        -->
        <template #meta>
            <StatusBadge v-if="status" :variant="status.variant" :label="status.label" size="xs" />
            <!--
                Criteria are a story's readiness, not its correctness; a story with none still runs. Stated quietly, so a fresh workspace doesn't
                teach people to ignore the colour.
            -->
            <span class="w-20 shrink-0 text-right">{{ authored === 0 ? `no criteria` : `${authored} criteria` }}</span>
        </template>

        <!--
            Its own margins and a measured column (68ch, prose.css), not the list's row padding, since an unbounded 72rem card ran criteria past a
            readable line length.
        -->
        <template #below>
            <!-- Escape closes the row, which unmounts the document and triggers its own flush, so leaving never loses an edit. -->
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

                <!--
                    Outside the measured column: kept inside the 68ch rule, these buttons floated in empty space either side and read as a stray
                    cluster.
                -->
                <div class="mt-6 flex items-center justify-end gap-2 border-t border-line/60 pt-3">
                    <!-- Narrows the run to this story; not a second way to start one, the run pill still owns the gate and the label. -->
                    <Button label="Run only this" size="small" severity="secondary" @click="emit(`run`)">
                        <template #icon><Icon name="play" /></template>
                    </Button>
                    <!-- Delete asks once, in place; the ask costs less than a git restore for a stray click. -->
                    <Button v-if="!confirmRemove" size="small" severity="danger" label="Delete" @click="confirmRemove = true" />
                    <Button v-else size="small" severity="danger" :label="`Delete ${story.path.split(`/`).pop()}?`" @click="discard" />
                </div>
            </div>
        </template>
    </DisclosureRow>
</template>
