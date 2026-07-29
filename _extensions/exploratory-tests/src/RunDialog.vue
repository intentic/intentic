<script setup lang="ts">
import { Button, Checkbox, cmp, Dialog, Icon, InputText, Select } from "@intentic/extension-ui";
import { computed, ref, watch } from "vue";
import type { Story } from "./stories";
import { DEFAULT_MODEL_VALUE, modelForTurn, PROVIDER_OPTIONS, useModels } from "./useModels";
import type { StartRunInput } from "./useRuns";
import type { useTarget } from "./useTarget";

/* Everything a run needs, on one screen: WHICH stories, WHERE the app is, and WHO tests it.
 *
 * The target URL is the part that earns the dialog. A test pointed at nothing produces N sessions that each
 * discover the app is down and write the same blocked report — expensive, and the user learns it four minutes
 * later. So the URL is filled in from the repo's running dev server, the "start it" button is right here when it
 * is stopped, and the run cannot be submitted without one. */

const { stories, contents, projectNotes, target } = defineProps<{
    repo: string;
    stories: readonly Story[];
    contents: Readonly<Record<string, string>>;
    projectNotes?: string | undefined;
    target: ReturnType<typeof useTarget>;
}>();
const visible = defineModel<boolean>(`visible`, { required: true });
const emit = defineEmits<{ submit: [StartRunInput] }>();

const selected = ref(new Set<string>());
const provider = ref(`claude`);
const model = ref(DEFAULT_MODEL_VALUE);
const baseUrl = ref(``);
const starting = ref(false);
const startingPanel = ref(false);
const panelError = ref<string | undefined>(undefined);

const { models } = useModels(provider);

// A provider switch invalidates a pinned model — its ids belong to the provider that vends them.
watch(provider, () => (model.value = DEFAULT_MODEL_VALUE));

// Opening the dialog is the moment the suggestion is right: the panel may have been started since last time.
// Everything selected by default — the common gesture is "run them all", and unpicking is cheaper than picking.
watch(visible, (open) => {
    if (!open) {
        return;
    }
    panelError.value = undefined;
    selected.value = new Set(stories.map((story) => story.path));
    if (baseUrl.value === ``) {
        baseUrl.value = target.suggested.value;
    }
});
// The URL appears the moment the dev server does, so "Start it" fills the field without a second click.
watch(target.suggested, (suggested) => {
    if (baseUrl.value === `` && suggested !== ``) {
        baseUrl.value = suggested;
    }
});

const chosen = computed(() => stories.filter((story) => selected.value.has(story.path)));
const canRun = computed(() => chosen.value.length > 0 && baseUrl.value.trim() !== `` && !starting.value);

const toggle = (path: string): void => {
    const next = new Set(selected.value);
    if (!next.delete(path)) {
        next.add(path);
    }
    selected.value = next;
};

const startPanel = async (): Promise<void> => {
    startingPanel.value = true;
    panelError.value = undefined;
    try {
        await target.startPanel();
    } catch (error) {
        panelError.value = error instanceof Error ? error.message : String(error);
    } finally {
        startingPanel.value = false;
    }
};

const submit = (): void => {
    starting.value = true;
    try {
        emit(`submit`, {
            stories: chosen.value,
            contents,
            baseUrl: baseUrl.value.trim(),
            provider: provider.value,
            model: modelForTurn(model.value),
            projectNotes,
        });
    } finally {
        starting.value = false;
    }
};
</script>

<template>
    <Dialog v-model:visible="visible" modal header="Run exploratory tests" :style="{ width: `36rem` }">
        <div class="flex flex-col gap-5">
            <section class="flex flex-col gap-2">
                <div class="flex items-center justify-between">
                    <span :class="cmp.sectionLabel()">Stories</span>
                    <div class="flex items-center gap-2 text-2xs">
                        <button type="button" class="cursor-pointer text-muted hover:text-content" @click="selected = new Set(stories.map((s) => s.path))">
                            All
                        </button>
                        <span class="text-subtle">·</span>
                        <button type="button" class="cursor-pointer text-muted hover:text-content" @click="selected = new Set()">None</button>
                    </div>
                </div>
                <div class="max-h-56 overflow-auto rounded-lg border border-line bg-canvas scrollbar-thin">
                    <label
                        v-for="story in stories"
                        :key="story.path"
                        class="flex cursor-pointer items-center gap-3 border-b border-line/60 px-3 py-2 last:border-b-0 hover:bg-overlay"
                    >
                        <Checkbox :model-value="selected.has(story.path)" binary @update:model-value="toggle(story.path)" />
                        <span class="min-w-0 flex-1">
                            <span class="block truncate text-sm text-content">{{ story.title }}</span>
                            <span v-if="story.group" class="block truncate font-mono text-2xs text-subtle">{{ story.group }}</span>
                        </span>
                    </label>
                </div>
                <p class="text-2xs text-subtle">One session per story, running in parallel.</p>
            </section>

            <section class="flex flex-col gap-2">
                <span :class="cmp.sectionLabel()">Application under test</span>
                <InputText v-model="baseUrl" placeholder="http://localhost:5173" class="w-full" />
                <div v-if="panelError" :class="cmp.alertDanger()">{{ panelError }}</div>
                <!-- The dev server exists but is stopped: offer it here rather than sending the user to the
                     Preview tab and back. -->
                <div v-else-if="target.hasPanel.value && !target.running.value" class="flex items-center gap-2">
                    <p class="flex-1 text-2xs text-subtle">This repository's dev server is stopped.</p>
                    <Button label="Start it" size="small" severity="secondary" :disabled="startingPanel" @click="startPanel">
                        <template #icon><Icon name="play" /></template>
                    </Button>
                </div>
                <p v-else class="text-2xs text-subtle">The agents reach this from inside the sandbox, so a localhost address is the direct route.</p>
            </section>

            <section class="flex gap-3">
                <label class="flex flex-1 flex-col gap-1.5">
                    <span :class="cmp.sectionLabel()">Agent</span>
                    <Select v-model="provider" :options="[...PROVIDER_OPTIONS]" option-label="label" option-value="value" size="small" />
                </label>
                <label class="flex flex-1 flex-col gap-1.5">
                    <span :class="cmp.sectionLabel()">Model</span>
                    <Select v-model="model" :options="models" option-label="label" option-value="value" size="small" />
                </label>
            </section>

            <p class="text-2xs text-subtle">
                Each session runs unattended in its own worktree with tool permissions bypassed, so nothing stops mid-test to ask. The brief forbids changing
                the application's source — defects get reported, not fixed.
            </p>
        </div>

        <template #footer>
            <Button label="Cancel" severity="secondary" size="small" @click="visible = false" />
            <Button :label="`Run ${chosen.length || ``} ${chosen.length === 1 ? `test` : `tests`}`.replace(/\s+/g, ` `)" size="small" :disabled="!canRun" @click="submit">
                <template #icon><Icon name="play" /></template>
            </Button>
        </template>
    </Dialog>
</template>
