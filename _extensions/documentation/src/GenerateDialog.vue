<!-- Choosing a run's SCOPE, which is the only decision a generation run really needs from the user.

     The default is deliberately not "everything". A package is one isolated agent, so documenting a 50-package
     monorepo is fifty sessions and real money — and after the first run, the packages worth revisiting are the ones
     that changed. So the presets are "what has no document" and "what the tool says is stale", with everything as
     an explicit choice rather than the path of least resistance. -->
<script setup lang="ts">
import { AgentRunButton, type AgentRunChoice, Button, Checkbox, Icon, Modal, useAgentRunPick } from "@intentic/extension-ui";
import { computed, ref, watch } from "vue";
import { host } from "./host";
import type { DocIndex } from "./docModel.js";

const { packages, index, label } = defineProps<{
    // Every package the facts tool found in this repo, in path order.
    packages: readonly string[];
    // The generated index, when the repo has one — the source of "undocumented" and "stale".
    index: DocIndex | undefined;
    label: string;
}>();

const open = defineModel<boolean>({ required: true });
const emit = defineEmits<{ start: [dirs: readonly string[], pick: AgentRunChoice | undefined] }>();

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

/* Which model every session in this run opens on, and the caret that re-points them for this run alone. ONE
 * pick for the whole fan-out rather than one per package: the dialog starts N+1 sessions on one press, and a
 * per-package model would be N+1 decisions to make a single scope choice. Cleared on start, so re-opening the
 * dialog is back on the sandbox's standing list. */
const runModel = useAgentRunPick(() => host().models);

const start = (): void => {
    emit(`start`, [...chosen.value], runModel.overridden.value ? runModel.model.value : undefined);
    runModel.clear();
    open.value = false;
};
</script>

<template>
    <Modal v-model:open="open" size="md" :header="`Generate documentation for ${label}`">
        <div class="flex flex-col gap-4">
            <p class="text-xs text-muted">
                One agent writes the repository's map first — the components, the vocabulary, the reading order. The packages you pick below are then
                documented in parallel, one agent each, and land as a draft you review before anything is committed.
            </p>

            <div class="flex flex-wrap items-center gap-2">
                <Button size="small" severity="secondary" label="Undocumented" @click="chosen = [...undocumented]" />
                <Button size="small" severity="secondary" :disabled="stale.length === 0" label="Stale" @click="chosen = [...stale]" />
                <Button size="small" severity="secondary" label="Everything" @click="chosen = [...packages]" />
                <span class="ml-auto text-2xs text-subtle">{{ chosen.length }} of {{ packages.length }}</span>
            </div>

            <!-- A wash instead of a frame with hairlines between every row: the checkboxes already give the list
                 its structure, and 55 of them inside a ruled box is a spreadsheet. -->
            <div class="max-h-72 overflow-y-auto rounded-lg bg-content/4 p-1">
                <label
                    v-for="dir in packages"
                    :key="dir"
                    class="flex cursor-pointer items-center gap-3 rounded-md px-2.5 py-1.5 transition-colors hover:bg-content/5"
                >
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
                <AgentRunButton
                    label="Generate"
                    :model-label="runModel.model.value.label"
                    :overridden="runModel.overridden.value"
                    :disabled="chosen.length === 0"
                    @run="start"
                    @pick="runModel.choose"
                />
            </div>
        </div>
    </Modal>
</template>
