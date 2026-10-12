<!-- The one way a view narrows what it shows to one repository: a quiet picker in the page header's actions. -->
<script setup lang="ts">
import { computed, type Ref, type WritableComputedRef } from "vue";
import { useRailMemory } from "../../composables/useRailMemory.js";
import { useT } from "../../i18n/index.js";
import Picker from "./Picker.vue";
import { normalizePickerGroups, type PickerGroup, type PickerOptions } from "./picker.js";
import type { RepoPickerAll } from "./repoPicker.js";

// Sits in <SplitView>'s #actions, after <ProjectChip>, never as a column beside the body: a rail of repositories takes
// width from every page that has one and none from the pages that don't, so views stop agreeing on where scope lives.
// The caller keeps the choice in the URL (`?repo=`, through api.route) so it is linkable and Back works, and leaves this
// out when the host already bound the view to one repository.

const t = useT();

const { repos, all, memory } = defineProps<{
    /** The repositories, a flat list or labelled groups; each option's `description` is its quiet count. */
    repos: PickerOptions<string>;
    /** Offers "All repositories" first, the state an undefined model means. Without it a repository is always chosen. */
    all?: RepoPickerAll;
    /** Remembers the pick across visits under this key, so the view's bare address reopens on it. */
    memory?: string;
}>();

// undefined = every repository. Kept undefined rather than a sentinel so the URL simply omits the parameter.
const selected = defineModel<string | undefined>();

// Not ``: a workspace-root repository is spelled ``, so "all" needs a value no repository can have.
const ALL = `\u0000all`;

const groups = computed<readonly PickerGroup<string>[]>(() => normalizePickerGroups(repos).filter((group) => group.options.length > 0));
const values = (): readonly string[] => groups.value.flatMap((group) => group.options.map((option) => option.value));

// Picks write through the memory when there is one: only a pick may remember "all", so a widened scope stays wide.
// `memory` is read once, like a key: a view does not change what it remembers under.
const target: Ref<string | undefined> | WritableComputedRef<string | undefined> =
    memory === undefined ? selected : useRailMemory(memory, selected, values);

// Over a single repository there is nothing to choose: the picker would point at the only thing on screen.
const choosable = computed(() => values().length > 1);

const options = computed<PickerOptions<string>>(() =>
    all === undefined
        ? groups.value
        : [
              { options: [{ value: ALL, label: t(`ui.repoPicker.allRepositories`), icon: all.icon ?? `folder`, description: all.description }] },
              ...groups.value,
          ],
);

const picked = computed<string | undefined>({
    get: () => selected.value ?? (all === undefined ? undefined : ALL),
    set: (value) => {
        if (value === ALL) {
            target.value = undefined;
        } else if (value !== undefined) {
            target.value = value;
        }
    },
});
</script>

<template>
    <Picker
        v-if="choosable"
        v-model="picked"
        :options="options"
        variant="ghost"
        :aria-label="t(`ui.repoPicker.repository`)"
        :placeholder="t(`ui.repoPicker.repository`)"
    />
</template>
