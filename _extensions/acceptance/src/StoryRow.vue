<script setup lang="ts">
import { Button, cmp, Icon, StatusBadge, type StatusVariant } from "@intentic/extension-ui";
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
 * CRITERIA ARE EDITED AS A LIST, not as a form: Enter opens the next one, Backspace on an empty one removes it,
 * the arrows walk them. That is what the content actually is — a checklist someone adds to as they think — and
 * every criterion typed without reaching for the mouse is one more promise that gets written down instead of
 * being left in someone's head.
 *
 * The title still never moves the file. Editing renames the heading and leaves `docs/user-stories/01-sign-in.md`
 * exactly where git, the ordering prefix and every link to it expect it. */

const { story, content, expanded, status, autofocus, save, remove } = defineProps<{
    story: Story;
    // The file's text as last read. Loaded into the draft when the row opens, and never afterwards: a refetch
    // triggered by this row's own save must not yank the text out from under the cursor.
    content?: string | undefined;
    expanded: boolean;
    // What the latest run said about this story, when it covered it.
    status?: { readonly label: string; readonly variant: StatusVariant } | undefined;
    // Just created by the composer: open on the first empty criterion so the author keeps typing.
    autofocus?: boolean;
    save: (input: { readonly path: string; readonly markdown: string }) => Promise<void>;
    remove: (path: string) => Promise<void>;
}>();
const emit = defineEmits<{ toggle: []; run: [] }>();

// Long enough that a sentence is written as one save rather than as fifteen, short enough that leaving the row is
// never a race with the timer.
const SAVE_AFTER_MS = 700;

const title = ref(``);
const narrative = ref(``);
const criteria = ref<string[]>([]);
const inputs = ref<Record<number, HTMLInputElement | undefined>>({});
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
        const input = inputs.value[at];
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
        <button
            type="button"
            class="flex w-full cursor-pointer items-center gap-3 px-4 py-2 text-left hover:bg-overlay"
            :class="expanded && `bg-overlay`"
            :aria-expanded="expanded"
            @click="emit(`toggle`)"
        >
            <Icon :name="expanded ? `chevron-down` : `chevron-right`" class="shrink-0 text-subtle" />
            <!-- Open, the heading below is the title, so the row identifies the FILE instead of repeating it. -->
            <span v-if="expanded" class="min-w-0 flex-1 truncate font-mono text-2xs text-subtle">{{ story.path }}</span>
            <span v-else class="min-w-0 flex-1 truncate text-sm text-content">{{ story.title }}</span>
            <!-- Criteria are the story's readiness, not its correctness: a story with none still runs, nobody has
                 just said yet what "done" means for it. Stated quietly for that reason — a fresh workspace that
                 shouted a warning on every row would be teaching people to ignore the colour. -->
            <span class="shrink-0 text-2xs text-subtle">{{ authored === 0 ? `no criteria` : `${authored} criteria` }}</span>
            <StatusBadge v-if="status" :variant="status.variant" :label="status.label" size="xs" />
        </button>

        <div v-if="expanded" class="border-t border-line/60 bg-canvas px-4 py-3">
            <input
                v-model="title"
                placeholder="Sign in with an email address"
                :class="cmp.input(`w-full text-sm font-medium`)"
                @keydown.enter.prevent="focusAt(0)"
                @keydown.esc="emit(`toggle`)"
            />

            <div class="mt-4 flex items-center justify-between">
                <span :class="cmp.sectionLabel()">Acceptance criteria</span>
                <span class="text-2xs text-subtle">one verdict each, in this order</span>
            </div>
            <div class="mt-2 flex flex-col gap-1.5">
                <div v-for="(_, index) in criteria" :key="index" class="flex items-center gap-2">
                    <span class="w-4 shrink-0 text-right font-mono text-2xs text-subtle">{{ index + 1 }}</span>
                    <input
                        :ref="(el) => (inputs[index] = el as HTMLInputElement)"
                        v-model="criteria[index]"
                        :placeholder="index === 0 ? `A wrong password shows an error and keeps the email field filled` : `and then…`"
                        :class="cmp.input(`min-w-0 flex-1 py-1.5 text-xs`)"
                        @keydown.enter.prevent="insertAfter(index)"
                        @keydown.backspace="shrink(index, $event)"
                        @keydown.up.prevent="focusAt(index - 1)"
                        @keydown.down.prevent="focusAt(index + 1)"
                        @keydown.esc="emit(`toggle`)"
                    />
                    <button
                        type="button"
                        class="shrink-0 cursor-pointer p-1 text-subtle hover:text-danger"
                        aria-label="Remove criterion"
                        @click="drop(index)"
                    >
                        <Icon name="times" />
                    </button>
                </div>
            </div>
            <p class="mt-1.5 pl-6 text-2xs text-subtle">
                Enter opens the next one.
                <template v-if="authored === 0">
                    With none, the agent reads checkable claims out of your prose instead — which works, but then the report grades itself against its
                    own reading rather than against what you promised.
                </template>
            </p>

            <label class="mt-4 flex flex-col gap-1.5">
                <span :class="cmp.sectionLabel()">The story</span>
                <textarea
                    v-model="narrative"
                    rows="5"
                    :class="cmp.input(`w-full resize-y font-mono text-xs leading-relaxed`)"
                    placeholder="As a returning visitor, I want to sign in with my email and password so that I reach my own workspace.&#10;&#10;What the user is trying to do, where they start, and what counts as success. Handed to the agent verbatim — a test login or a fixture it needs belongs here."
                    @keydown.esc="emit(`toggle`)"
                />
            </label>

            <div v-if="failure" :class="cmp.alertDanger(`mt-3`)">{{ failure }}</div>

            <div class="mt-3 flex items-center gap-3">
                <!-- Autosave is only trustworthy if it says so. Silence here would make a story authored and
                     closed in six seconds feel like a story that was lost. -->
                <span class="text-2xs" :class="state === `saved` ? `text-success` : `text-subtle`">{{
                    state === `saving` ? `Saving…` : state === `dirty` ? `Unsaved` : state === `saved` ? `Saved` : ``
                }}</span>
                <div class="ml-auto flex items-center gap-2">
                    <Button label="Run this story" size="small" severity="secondary" @click="emit(`run`)">
                        <template #icon><Icon name="play" /></template>
                    </Button>
                    <!-- Delete asks once, in place: a story is a file in the repo, and the ask costs less than a
                         restore from git for someone who clicked the wrong row. -->
                    <button v-if="!confirmRemove" type="button" :class="cmp.buttonDanger()" @click="confirmRemove = true">Delete</button>
                    <button v-else type="button" :class="cmp.buttonDanger()" @click="discard">Delete {{ story.path.split(`/`).pop() }}?</button>
                </div>
            </div>
        </div>
    </div>
</template>
