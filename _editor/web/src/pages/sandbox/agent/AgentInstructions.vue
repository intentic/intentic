<script setup lang="ts">
import type { BuiltinPromptText, SystemPromptMode } from "@intentic/sandbox-contract";
import { Button, CopyButton, MarkdownDocument, Modal, Notice, Row, RowGroup, SegmentedControl } from "@intentic/ui";
import { useAsyncAction } from "@intentic/ui/async";
import { computed, ref } from "vue";
import { sandboxJson } from "../../../composables/sandbox/sandboxClient";
import { useSandboxSettings } from "../../../composables/sandbox/useSandboxSettings";
import { useDraft } from "../../../composables/useDraft";
import { promptReach, spokenList } from "./promptReach";
import InstructionsInfo from "./InstructionsInfo.vue";

const { settings, patch, save } = useSandboxSettings();

const PROMPT_MAX = 20000;
const PROMPT_MODES: { label: string; value: SystemPromptMode }[] = [
    { label: `Intentic`, value: `intentic` },
    { label: `Claude`, value: `claude` },
    { label: `Custom`, value: `custom` },
];
const promptMode = computed<SystemPromptMode>(() => settings.value?.systemPromptMode ?? `intentic`);
const prompt = useDraft(() => settings.value?.systemPrompt);
// What is on disk, handed to the document surface so IT decides what "unsaved" means. Undefined until the
// settings arrive, which is what stops an empty draft looking like a prompt somebody deleted.
const stored = computed(() => settings.value?.systemPrompt);

const savePrompt = (text: string): void => patch({ systemPrompt: text.trim() });
const setPromptMode = (mode: string): void => patch({ systemPromptMode: mode as SystemPromptMode });

const builtinPrompts = ref<Partial<Record<string, BuiltinPromptText>>>({});
const viewingBase = ref<`intentic` | `claude` | undefined>(undefined);
const { busy: builtinBusy, notice: builtinError, run: runBuiltin } = useAsyncAction();
const loadBuiltin = async (base: `intentic` | `claude`): Promise<BuiltinPromptText | undefined> => {
    if (builtinPrompts.value[base] === undefined) {
        await runBuiltin(async () => {
            builtinPrompts.value = { ...builtinPrompts.value, [base]: await sandboxJson<BuiltinPromptText>(`/settings/system-prompt/${base}`) };
        }, `Couldn't read that system prompt from your sandbox.`);
    }
    return builtinPrompts.value[base];
};
const viewBuiltin = async (base: `intentic` | `claude`): Promise<void> => {
    viewingBase.value = base;
    await loadBuiltin(base);
};
const VIEW_BASES = [
    { label: `Intentic`, value: `intentic` },
    { label: `Claude`, value: `claude` },
];
const setViewingBase = (base: string): void => void viewBuiltin(base as `intentic` | `claude`);

const forkBuiltin = async (base: `intentic` | `claude`): Promise<void> => {
    const fetched = await loadBuiltin(base);
    if (fetched !== undefined) {
        prompt.value = fetched.text;
        viewingBase.value = undefined;
        setPromptMode(`custom`);
    }
};

const reach = promptReach();
const reachLine =
    reach.adds.length > 0
        ? `Replaces the prompt on ${spokenList(reach.replaces)} · added to theirs on ${spokenList(reach.adds)}.`
        : `Replaces the prompt on ${spokenList(reach.replaces)}.`;
</script>

<template>
    <RowGroup label="Instructions">
        <template #info><InstructionsInfo /></template>

        <Row icon="pencil" title="System prompt">
            <template #description>
                <template v-if="promptMode === `custom`">Your own prompt: the agent runs on this text alone.</template>
                <template v-else-if="promptMode === `claude`">Claude Code's own prompt, as shipped in your sandbox's CLI.</template>
                <template v-else>Intentic's own prompt, tuned for this app.</template>
            </template>
            <template #control>
                <SegmentedControl :model-value="promptMode" :options="PROMPT_MODES" @update:model-value="setPromptMode" />
            </template>
            <template #below>
                <template v-if="promptMode !== `custom`">
                    <div class="flex flex-wrap items-center gap-2">
                        <Button label="View prompt" size="small" severity="secondary" @click="viewBuiltin(promptMode)" />
                        <Button label="Edit a copy" size="small" severity="secondary" :loading="builtinBusy" @click="forkBuiltin(promptMode)" />
                    </div>
                    <p class="mt-2 text-2xs text-subtle">{{ reachLine }}</p>
                </template>

                <template v-else>
                    <!-- A PROMPT IS A DOCUMENT, and it was the worst-served one in the app: five monospace rows
                         with no structure visible, onto a file that runs to twenty thousand characters. It is
                         written on the same surface as the safety policy, a skill and a file in the workspace,
                         under the same explicit save — this text is read at the start of every turn, so it
                         waits to be told rather than going live mid-sentence. -->
                    <div class="ui-field-shell max-h-[60dvh] overflow-auto p-3" style="--prose-measure: 72ch">
                        <MarkdownDocument
                            v-model="prompt"
                            :editable="settings !== undefined"
                            :stored="stored"
                            :saving="save.isPending.value"
                            save="explicit"
                            label="System prompt"
                            :max-chars="PROMPT_MAX"
                            placeholder="Write the assistant's system prompt, or start from one of the built-in prompts below."
                            class="min-h-64"
                            @save="savePrompt"
                        />
                    </div>

                    <Notice tone="warning" class="mt-2 text-2xs">
                        Your text becomes the whole prompt on {{ spokenList(reach.replaces) }}: including what this app tells the assistant about its
                        own question cards, checklist panel and browser tools.
                        <template v-if="reach.adds.length > 0">On {{ spokenList(reach.adds) }} it is added to their prompt instead.</template>
                    </Notice>

                    <div class="mt-2 flex flex-wrap items-center gap-2">
                        <Button label="Start from Intentic's" size="small" severity="secondary" :loading="builtinBusy" @click="forkBuiltin(`intentic`)" />
                        <Button label="Start from Claude's" size="small" severity="secondary" :loading="builtinBusy" @click="forkBuiltin(`claude`)" />
                    </div>
                </template>
                <Notice v-if="builtinError !== undefined" :of="builtinError" class="mt-2" />
            </template>
        </Row>
    </RowGroup>

    <Modal :open="viewingBase !== undefined" size="lg" header="Built-in system prompts" @update:open="viewingBase = undefined">
        <SegmentedControl
            v-if="viewingBase !== undefined"
            :model-value="viewingBase"
            :options="VIEW_BASES"
            aria-label="Which built-in prompt to read"
            @update:model-value="setViewingBase"
        />
        <div v-if="builtinBusy" class="flex items-center gap-2 py-6 text-xs text-muted">
            <Icon name="spinner" spin />
            Reading it from your sandbox…
        </div>
        <Notice v-else-if="builtinError !== undefined" :of="builtinError" class="mt-3" />
        <template v-else-if="viewingBase !== undefined && builtinPrompts[viewingBase] !== undefined">
            <p class="mt-3 text-xs text-muted">
                <template v-if="viewingBase === `claude`">
                    Claude Code's own prompt, read out of the CLI in your sandbox
                    <span class="font-mono text-content">{{ builtinPrompts[viewingBase]?.version }}</span
                    >, not a copy kept by this app. Choose Claude and it keeps updating with the sandbox; fork it and you own it from here.
                </template>
                <template v-else>
                    Intentic's own prompt: the default, and the one we tune for this app. Choose Intentic and it keeps updating with the app; fork it
                    and you own it from here.
                </template>
                Either way, this app's own guidance about its question cards, checklist panel and browser tools is added on top; only a custom prompt
                drops that.
            </p>
            <!-- READ IT AS THE THING YOU WOULD BE FORKING. It was a `<pre>`: one grey monospace slab at 10px,
                 which is the one way to read a 20,000-character document that tells you nothing about its
                 shape. The same surface as the box behind this modal, with nothing to type into, so "View
                 prompt" and "Edit a copy" are the same document twice rather than two different screens. -->
            <div class="mt-2 max-h-[55dvh] overflow-auto rounded-lg border border-line bg-canvas p-3" style="--prose-measure: 76ch">
                <MarkdownDocument :model-value="builtinPrompts[viewingBase]?.text ?? ``" label="Built-in system prompt" />
            </div>
            <div class="mt-3 flex items-center justify-end gap-2">
                <CopyButton :text="builtinPrompts[viewingBase]?.text ?? ``" label="Copy" />
                <Button label="Edit a copy" size="small" @click="forkBuiltin(viewingBase)" />
            </div>
        </template>
    </Modal>
</template>
