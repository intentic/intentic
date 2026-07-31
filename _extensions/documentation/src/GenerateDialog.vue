<!-- Choosing a run's SCOPE, which is the only decision a generation run really needs from the user.

     The default is deliberately not "everything". A package is one isolated agent, so documenting a 50-package
     monorepo is fifty sessions and real money — and after the first run, the packages worth revisiting are the ones
     that changed. So the presets are "what has no document" and "what the tool says is stale", with everything as
     an explicit choice rather than the path of least resistance. -->
<script setup lang="ts">
import { Button, Checkbox, cmp, Dialog, Icon } from "@intentic/extension-ui";
import { computed, ref, watch } from "vue";
import type { DocIndex } from "./docModel.js";

const { packages, index, label } = defineProps<{
    // Every package the facts tool found in this repo, in path order.
    packages: readonly string[];
    // The generated index, when the repo has one — the source of "undocumented" and "stale".
    index: DocIndex | undefined;
    label: string;
}>();

const open = defineModel<boolean>({ required: true });
const emit = defineEmits<{ start: [dirs: readonly string[]] }>();

const chosen = ref<string[]>([]);

const undocumented = computed(() => {
    const documented = new Set((index?.entries ?? []).map((entry) => entry.dir));
    return packages.filter((dir) => !documented.has(dir));
});
const stale = computed(() => (index?.entries ?? []).filter((entry) => entry.stale).map((entry) => entry.dir));

// The preset that is most useful depends on what exists: a repo with no documents wants everything undocumented
// (which is everything), and a documented repo almost always wants only what drifted.
const reset = (): void => {
    chosen.value = stale.value.length > 0 ? [...new Set([...stale.value, ...undocumented.value])] : [...undocumented.value];
};
watch(open, (value) => value && reset(), { immediate: true });

const toggle = (dir: string): void => {
    chosen.value = chosen.value.includes(dir) ? chosen.value.filter((entry) => entry !== dir) : [...chosen.value, dir];
};

const start = (): void => {
    emit(`start`, [...chosen.value]);
    open.value = false;
};
</script>

<template>
    <Dialog v-model:visible="open" modal :header="`Generate documentation for ${label}`" :style="{ width: `34rem` }">
        <div class="flex flex-col gap-4">
            <p class="text-xs text-muted">
                One agent writes the repository's map first — the components, the vocabulary, the reading order. The
                packages you pick below are then documented in parallel, one agent each, and land as a draft you
                review before anything is committed.
            </p>

            <div class="flex flex-wrap items-center gap-2">
                <Button size="small" severity="secondary" outlined label="Undocumented" @click="chosen = [...undocumented]" />
                <Button size="small" severity="secondary" outlined :disabled="stale.length === 0" label="Stale" @click="chosen = [...stale]" />
                <Button size="small" severity="secondary" outlined label="Everything" @click="chosen = [...packages]" />
                <span class="ml-auto text-2xs text-subtle">{{ chosen.length }} of {{ packages.length }}</span>
            </div>

            <div class="max-h-72 divide-y divide-line overflow-y-auto rounded-lg border border-line">
                <label v-for="dir in packages" :key="dir" class="flex cursor-pointer items-center gap-3 px-3 py-1.5 hover:bg-canvas">
                    <Checkbox :model-value="chosen.includes(dir)" binary @update:model-value="toggle(dir)" />
                    <span class="min-w-0 flex-1 truncate font-mono text-xs">{{ dir }}</span>
                    <span v-if="stale.includes(dir)" class="shrink-0 text-2xs text-warning">stale</span>
                    <span v-else-if="undocumented.includes(dir)" class="shrink-0 text-2xs text-subtle">new</span>
                </label>
            </div>

            <!-- Naming the cost is part of the decision. A user who picks fifty packages should know that is fifty
                 sessions before they click, not after the bill. -->
            <p v-if="chosen.length > 8" class="flex items-start gap-2 text-2xs text-muted">
                <Icon name="info-circle" class="mt-0.5 shrink-0" />
                <span>{{ chosen.length }} packages means {{ chosen.length + 1 }} agent sessions, running in parallel.</span>
            </p>

            <div class="flex justify-end gap-2">
                <Button size="small" severity="secondary" text label="Cancel" @click="open = false" />
                <button type="button" :class="cmp.buttonPrimary()" :disabled="chosen.length === 0" @click="start">Generate</button>
            </div>
        </div>
    </Dialog>
</template>
