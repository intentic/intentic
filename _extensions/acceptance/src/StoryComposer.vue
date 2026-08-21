<script setup lang="ts">
import { Icon } from "@intentic/extension-ui";
import { computed, ref } from "vue";
import { slugOf, storyPath } from "./stories";

/* HOW A STORY STARTS: one line, in the list, in the group you are already looking at.
 *
 * A story is a promise someone just thought of, and the cost of writing it down has to be lower than the cost of
 * not bothering. So there is exactly ONE field here: the title, and Enter creates the file. Everything else a
 * story can carry (criteria, the narrative, the tester's notes) is added afterwards in the row that appears,
 * where the author can see it against the stories around it.
 *
 * NO REPOSITORY OR GROUP PICKER, because this row lives INSIDE one: the destination is the heading you typed
 * under, not a select you have to notice. That is why there is one composer per group rather than one for the
 * view, and one at the end of each repo, whose group is the top level.
 *
 * A GROUP CAN BE MADE BY NAMING IT. Typing `03-equip/Connect GitHub` writes the story into that subdirectory,
 * creating it if it is new: the one gesture the per-group composers cannot offer, since a group that does not
 * exist yet has no row to type in. The path preview below is what teaches it: it shows the file as you type, so
 * the prefix visibly moves the story rather than ending up in its name.
 *
 * A collision REFUSES rather than overwrites: `save` is a plain upload, so creating a second "Sign in" would
 * silently replace the first story's criteria with an empty file. */

const { repo, group, taken } = defineProps<{
    repo: string;
    // The subdirectory this composer writes into; "" is the repo's top level.
    group: string;
    // Every story path in the workspace: a title whose file already exists must not be created over it.
    taken: readonly string[];
}>();
const emit = defineEmits<{ create: [{ path: string; title: string }] }>();

const title = ref(``);

const trimmed = computed<string>(() => title.value.trim());
// `<group>/<title>` splits on the LAST slash: everything before it is the destination directory (nested groups
// included, which the walk reads back as their first segment), everything after it is the story's own name.
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
            <!-- `min-h-11`: the field is transparent and borderless, so its own box was the height of one line
                 of text: 22px, and the row's padding around it belonged to the row, not to the input. On a
                 phone that meant the only way to start typing was to hit a 22px band in the middle of a 48px
                 row. The field now fills the row it sits in, which changes nothing visible (there is no border
                 or fill to grow) and makes the whole row the thing you tap. -->
            <input
                v-model="title"
                :placeholder="group === `` ? `New story, a title, or group/title to file it under one` : `New story in ${group}/, type a title`"
                class="min-h-11 min-w-0 flex-1 bg-transparent text-sm text-content placeholder:text-subtle focus:outline-none"
                @keydown.enter.prevent="submit"
                @keydown.esc="title = ``"
            />
            <!-- The file this is about to become. Shown while typing rather than after the fact: the title is the
                 filename and the prefix is the directory, and those are the decisions here that are annoying to
                 undo. The group is included so a typed prefix visibly lands somewhere. -->
            <span v-if="named !== ``" class="shrink-0 truncate font-mono text-2xs" :class="clash ? `text-warning` : `text-subtle`">
                {{ destination === `` ? `` : `${destination}/` }}{{ path.split(`/`).pop() }}
            </span>
        </div>
        <p v-if="clash" class="mt-1 pl-7 text-2xs text-warning">That file already exists: open it below, or give this one another name.</p>
    </div>
</template>
