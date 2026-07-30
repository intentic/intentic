<script setup lang="ts">
import { Button, cmp, Dialog, Icon, InputText, Select } from "@intentic/extension-ui";
import { computed, ref, watch } from "vue";
import { criteriaOf, narrativeOf, slugOf, type Story, storyMarkdown, storyPath } from "./stories";

/* Where a story is WRITTEN — the half of this area that was missing while stories were only ever read off disk.
 *
 * Three fields, and the third is the point: TITLE, the narrative prose, and the acceptance criteria as a list of
 * rows. Criteria are what a run is graded against, so authoring them as rows rather than as free text is what
 * makes the report a matrix — the brief hands the agent this exact list, numbered, and demands one verdict per
 * entry in order. Type them as prose in the narrative box instead and you get the agent's paraphrase back.
 *
 * It writes ordinary markdown to the repo (stories.ts storyMarkdown), which round-trips through the same parsers
 * that read a hand-written story. Nothing here is a store: the file in the repo is the story.
 *
 * EDITING NEVER MOVES THE FILE. A new story's filename is derived from its title; an existing story's path is
 * left exactly as it is, whatever its extension. Renaming a file is the workspace tree's job, and a title edit
 * that silently deleted `docs/user-stories/01-sign-in.md` to write `sign-in.md` would take the ordering prefix,
 * the git history's continuity, and any link to it with it. */

const { story, content, repos } = defineProps<{
    // Absent ⇒ authoring a new story.
    story?: Story | undefined;
    content?: string | undefined;
    // Every repo that can hold stories — the destination picker for a new one.
    repos: readonly string[];
}>();
const visible = defineModel<boolean>(`visible`, { required: true });
const emit = defineEmits<{ save: [{ path: string; markdown: string }]; remove: [string] }>();

const repo = ref(``);
const title = ref(``);
const narrative = ref(``);
// Rows rather than a text blob: each is one criterion, and the order is the order the report reports in.
const criteria = ref<string[]>([]);
const confirmRemove = ref(false);

// Opening is the moment the fields are loaded — the dialog is kept mounted, so nothing else resets them, and a
// story edited, closed and reopened must not show the last story's text.
watch(visible, (open) => {
    if (!open) {
        return;
    }
    confirmRemove.value = false;
    repo.value = story?.repo ?? repos[0] ?? ``;
    title.value = story?.title ?? ``;
    narrative.value = narrativeOf(content);
    criteria.value = [...criteriaOf(content)];
});

// A new story's path comes from its title; an existing one keeps its own. Shown to the user, because "which file
// am I about to create" is the one thing this dialog can get wrong in a way that is annoying to undo.
const path = computed<string>(() => story?.path ?? storyPath(repo.value, slugOf(title.value)));
const canSave = computed<boolean>(() => title.value.trim() !== `` && repo.value !== ``);

const setCriterion = (index: number, text: string): void => {
    criteria.value = criteria.value.map((existing, at) => (at === index ? text : existing));
};

const save = (): void => {
    emit(`save`, {
        path: path.value,
        // Empty rows are dropped by storyMarkdown, so an author can leave the trailing blank row they just added.
        markdown: storyMarkdown({ title: title.value, narrative: narrative.value, criteria: criteria.value }),
    });
};
</script>

<template>
    <Dialog v-model:visible="visible" modal :header="story ? `Edit story` : `New story`" :style="{ width: `44rem` }">
        <div class="flex flex-col gap-5">
            <section class="flex gap-3">
                <label class="flex flex-2 flex-col gap-1.5">
                    <span :class="cmp.sectionLabel()">Title</span>
                    <InputText v-model="title" placeholder="Sign in with an email address" class="w-full" />
                </label>
                <label class="flex flex-1 flex-col gap-1.5">
                    <span :class="cmp.sectionLabel()">Repository</span>
                    <!-- Fixed once the file exists: see the note above on why editing never moves it. -->
                    <Select v-if="!story" v-model="repo" :options="[...repos]" size="small" />
                    <span v-else class="truncate py-1.5 font-mono text-xs text-muted">{{ story.repo }}</span>
                </label>
            </section>

            <label class="flex flex-col gap-1.5">
                <span :class="cmp.sectionLabel()">The story</span>
                <textarea
                    v-model="narrative"
                    rows="7"
                    :class="cmp.input(`w-full resize-y font-mono text-xs leading-relaxed`)"
                    placeholder="As a returning visitor, I want to sign in with my email and password so that I reach my own workspace.&#10;&#10;Write it the way you would explain the feature to someone who has never seen the app: what the user is trying to do, where they start, and what counts as success."
                />
                <span class="text-2xs text-subtle">
                    Handed to the agent verbatim. Anything it needs to know that is not obvious from the screen — a test login, a fixture — belongs
                    here or in the repo's <span class="font-mono">docs/user-stories/.acceptance.md</span>.
                </span>
            </label>

            <section class="flex flex-col gap-2">
                <div class="flex items-center justify-between">
                    <span :class="cmp.sectionLabel()">Acceptance criteria</span>
                    <span class="text-2xs text-subtle">{{ criteria.length }} · one verdict each per run</span>
                </div>
                <div v-for="(criterion, index) in criteria" :key="index" class="flex items-center gap-2">
                    <span class="w-4 shrink-0 text-right font-mono text-2xs text-subtle">{{ index + 1 }}</span>
                    <InputText
                        :model-value="criterion"
                        placeholder="A wrong password shows an error and keeps the email field filled"
                        class="min-w-0 flex-1"
                        @update:model-value="setCriterion(index, $event ?? ``)"
                    />
                    <button
                        type="button"
                        class="shrink-0 cursor-pointer p-1 text-subtle hover:text-danger"
                        aria-label="Remove criterion"
                        @click="criteria = criteria.filter((_, at) => at !== index)"
                    >
                        <Icon name="times" />
                    </button>
                </div>
                <div v-if="criteria.length === 0" :class="cmp.emptyState()">
                    No criteria yet. Without them the agent reads checkable claims out of your prose — which works, but the report then grades itself
                    against its own reading rather than against what you promised.
                </div>
                <button
                    type="button"
                    class="flex cursor-pointer items-center gap-1.5 self-start text-xs text-muted hover:text-content"
                    @click="criteria = [...criteria, ``]"
                >
                    <Icon name="plus" />
                    Add criterion
                </button>
            </section>

            <p class="font-mono text-2xs text-subtle">{{ path }}</p>
        </div>

        <template #footer>
            <!-- Delete asks once, in place: a story is a file in the repo, and the ask costs less than a
                 restore from git for someone who clicked the wrong row. -->
            <button v-if="story && !confirmRemove" type="button" :class="cmp.buttonDanger(`mr-auto`)" @click="confirmRemove = true">Delete</button>
            <button v-else-if="story" type="button" :class="cmp.buttonDanger(`mr-auto`)" @click="emit(`remove`, story.path)">
                Delete {{ story.path.split(`/`).pop() }}?
            </button>
            <Button label="Cancel" severity="secondary" size="small" @click="visible = false" />
            <Button :label="story ? `Save` : `Create story`" size="small" :disabled="!canSave" @click="save" />
        </template>
    </Dialog>
</template>
