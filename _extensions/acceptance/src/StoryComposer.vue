<script setup lang="ts">
import { Icon } from "@intentic/extension-ui";
import { computed, ref } from "vue";
import { slugOf, storyPath } from "./stories";

/* HOW A STORY STARTS: one line, in the list, in the repo you are already looking at.
 *
 * A story is a promise someone just thought of, and the cost of writing it down has to be lower than the cost of
 * not bothering. So there is exactly ONE field here — the title — and Enter creates the file. Everything else a
 * story can carry (criteria, the narrative, the tester's notes) is added afterwards in the row that appears,
 * where the author can see it against the stories around it.
 *
 * NO REPOSITORY PICKER, because this row lives INSIDE a repository's group: the destination is the heading you
 * typed under, not a select you have to notice. That is also why there is one composer per repo rather than one
 * for the view.
 *
 * The filename is shown as you type, and a collision REFUSES rather than overwrites: `save` is a plain upload, so
 * creating a second "Sign in" would silently replace the first story's criteria with an empty file. */

const { repo, taken } = defineProps<{
    repo: string;
    // Every story path in the workspace — a title whose file already exists must not be created over it.
    taken: readonly string[];
}>();
const emit = defineEmits<{ create: [{ path: string; title: string }] }>();

const title = ref(``);

const trimmed = computed<string>(() => title.value.trim());
const path = computed<string>(() => storyPath(repo, slugOf(trimmed.value)));
const clash = computed<boolean>(() => trimmed.value !== `` && taken.includes(path.value));

const submit = (): void => {
    if (trimmed.value === `` || clash.value) {
        return;
    }
    emit(`create`, { path: path.value, title: trimmed.value });
    title.value = ``;
};
</script>

<template>
    <div class="px-4 py-2">
        <div class="flex items-center gap-3">
            <Icon name="plus" class="shrink-0 text-subtle" />
            <input
                v-model="title"
                :placeholder="`New story — type a title and press Enter`"
                class="min-w-0 flex-1 bg-transparent text-sm text-content placeholder:text-subtle focus:outline-none"
                @keydown.enter.prevent="submit"
                @keydown.esc="title = ``"
            />
            <!-- The file this is about to become. Shown while typing rather than after the fact: the title is the
                 filename, and that is the one decision here that is annoying to undo. -->
            <span v-if="trimmed !== ``" class="shrink-0 truncate font-mono text-2xs" :class="clash ? `text-warning` : `text-subtle`">
                {{ path.split(`/`).pop() }}
            </span>
        </div>
        <p v-if="clash" class="mt-1 pl-7 text-2xs text-warning">That file already exists — open it below, or give this one another name.</p>
    </div>
</template>
