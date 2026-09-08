<script setup lang="ts">
import { Icon } from "@intentic/extension-ui";
import { computed, ref } from "vue";
import { slugOf, storyPath } from "./stories";

// One field, the title; Enter creates the file, everything else is added afterwards in the row that appears. No
// repo/group picker: this composer lives inside the group it writes to (one per group, one per repo at the top level).
// Typing `group/title` creates a new subdirectory, previewed live. A collision refuses rather than overwriting an
// existing file.

const { repo, group, taken } = defineProps<{
    repo: string;
    // The subdirectory this composer writes into; "" is the repo's top level.
    group: string;
    // Every story path in the workspace; a title whose file already exists must not be created over it.
    taken: readonly string[];
}>();
const emit = defineEmits<{ create: [{ path: string; title: string }] }>();

const title = ref(``);

const trimmed = computed<string>(() => title.value.trim());
// Splits on the last slash: everything before is the destination directory, everything after is the story's own name.
const cut = computed<number>(() => trimmed.value.lastIndexOf(`/`));
const named = computed<string>(() => (cut.value === -1 ? trimmed.value : trimmed.value.slice(cut.value + 1).trim()));
const destination = computed<string>(() => (cut.value === -1 ? group : trimmed.value.slice(0, cut.value).trim()));
const path = computed<string>(() => storyPath(repo, destination.value, slugOf(named.value)));
const clash = computed<boolean>(() => named.value !== `` && taken.includes(path.value));

const submit = (): void => {
    if (named.value === `` || clash.value) {
        return;
    }
    emit(`create`, { path: path.value, title: named.value });
    title.value = ``;
};
</script>

<template>
    <div class="px-4 py-2.5">
        <div class="flex items-center gap-3">
            <Icon name="plus" class="shrink-0 text-subtle" />
            <!-- min-h-11 fills the row rather than just one line's height, so the tappable area is the whole row, not a thin band in the middle. -->
            <input
                v-model="title"
                :placeholder="group === `` ? `New story, a title, or group/title to file it under one` : `New story in ${group}/, type a title`"
                class="field-bare ui-field-lit min-h-11 min-w-0 flex-1 rounded-md px-1"
                @keydown.enter.prevent="submit"
                @keydown.esc="title = ``"
            />
            <!-- The file this is about to become, shown while typing since the title becomes the filename and the prefix the directory. -->
            <span v-if="named !== ``" class="shrink-0 truncate font-mono text-2xs" :class="clash ? `text-warning` : `text-subtle`">
                {{ destination === `` ? `` : `${destination}/` }}{{ path.split(`/`).pop() }}
            </span>
        </div>
        <p v-if="clash" class="mt-1 pl-7 text-2xs text-warning">That file already exists: open it below, or give this one another name.</p>
    </div>
</template>
