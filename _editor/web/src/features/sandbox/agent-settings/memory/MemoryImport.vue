<script setup lang="ts">
import { MEMORY_FILE } from "@intentic/constants";
import { Button, Icon, Modal, Notice, ProseField, toneInk, toneTint, useCopied } from "@intentic/ui";
import { computed, ref, watch } from "vue";
import ProviderLogo from "../../../../parts/providers/ProviderLogo.vue";
import { IMPORT_PROMPT } from "../../../extensions/memoryImport";
import { ASSISTANTS } from "./assistants";
import { useMemoryImport } from "./useMemoryImport";
import { useT } from "@intentic/ui/i18n";

// Another assistant's memory of the owner, brought into the workspace's AGENTS.md in two steps drawn as one path: ask
// that assistant (a tile per assistant opens a chat with the export prompt already in it, and copies the prompt for one
// that cannot take it from the address), then paste its answer back. The prompt itself is there to read, folded: it is
// what gets sent, not something to study before pressing.

const t = useT();

const open = defineModel<boolean>("open", { required: true });
const emit = defineEmits<{ imported: [] }>();

const { answer, importing, failure, replaces, look, importMemory } = useMemoryImport();
const { copied, copy } = useCopied();

// Which tile was pressed, so step one reads as done and the tile as the one asked.
const asked = ref<string | undefined>();
const showPrompt = ref(false);
const answered = computed(() => answer.value.trim() !== ``);

watch(open, (now) => {
    if (now) {
        asked.value = undefined;
        showPrompt.value = false;
        void look();
    }
});

// The link's own navigation opens the chat; the copy rides the same press, inside the gesture the clipboard asks for.
const ask = (id: string, event: Event): void => {
    asked.value = id;
    void copy(IMPORT_PROMPT, event.currentTarget instanceof Element ? event.currentTarget : undefined);
};

const submit = async (): Promise<void> => {
    if (await importMemory()) {
        open.value = false;
        emit(`imported`);
    }
};

// The step badge, as the setup wizard draws it (StepSection): its number, or a check once it is done.
const badge = (done: boolean): string =>
    `relative flex size-6 shrink-0 items-center justify-center rounded-full border text-2xs font-medium ${
        done ? toneTint(`success`, `strong`, toneInk(`success`)) : toneTint(`neutral`, `soft`, `text-muted`)
    }`;
const TILE = [
    `relative flex flex-col items-center justify-center gap-2 rounded-lg border px-2 py-3 text-xs transition-colors outline-none`,
    `hover:border-line-strong hover:bg-content/5 hover:text-content focus-visible:ring-2 focus-visible:ring-primary-500/60`,
].join(` `);
</script>

<template>
    <Modal v-model:open="open" size="md" :header="t(`sandbox.agentMemory.bringMemoryOver`)">
        <ol class="flex flex-col">
            <!-- 1. Ask: a rule runs down from its badge to the next, so the two read as one path. -->
            <li class="relative flex gap-3 pb-6">
                <span class="absolute bottom-1 left-3 top-8 border-l border-line" aria-hidden="true" />
                <span :class="badge(asked !== undefined)">
                    <Icon v-if="asked !== undefined" name="check" />
                    <template v-else>1</template>
                </span>
                <div class="flex min-w-0 flex-1 flex-col gap-3">
                    <div class="flex min-h-6 items-center gap-2">
                        <h3 class="flex-1 text-sm font-medium text-content">{{ t(`sandbox.agentMemory.askYourAssistant`) }}</h3>
                        <Button
                            size="small"
                            tier="quiet"
                            :aria-label="showPrompt ? t(`sandbox.agentMemory.hidePrompt`) : t(`sandbox.agentMemory.showPrompt`)"
                            :aria-expanded="showPrompt"
                            v-tooltip.top="showPrompt ? t(`sandbox.agentMemory.hidePrompt`) : t(`sandbox.agentMemory.showPrompt`)"
                            @click="showPrompt = !showPrompt"
                        >
                            <template #icon><Icon :name="showPrompt ? `eye-slash` : `eye`" /></template>
                        </Button>
                    </div>

                    <div class="grid grid-cols-3 gap-2 sm:grid-cols-5">
                        <a
                            v-for="assistant in ASSISTANTS"
                            :key="assistant.id"
                            data-assistant
                            :href="assistant.chat(IMPORT_PROMPT)"
                            target="_blank"
                            rel="noopener noreferrer"
                            :class="[TILE, asked === assistant.id ? `border-line-strong text-content` : `border-line text-muted`]"
                            @click="ask(assistant.id, $event)"
                        >
                            <ProviderLogo :provider="assistant.brand" class="text-2xl text-content" />
                            {{ assistant.name }}
                            <Icon v-if="asked === assistant.id" name="check-circle" class="absolute right-1.5 top-1.5 text-2xs text-success" />
                        </a>
                        <!-- Any other assistant: the prompt, to paste wherever it is. -->
                        <button
                            type="button"
                            data-assistant
                            :class="[TILE, asked === `other` ? `border-line-strong text-content` : `border-line text-muted`]"
                            @click="ask(`other`, $event)"
                        >
                            <Icon name="copy" class="text-2xl" />
                            {{ t(`sandbox.agentMemory.other`) }}
                            <Icon v-if="asked === `other`" name="check-circle" class="absolute right-1.5 top-1.5 text-2xs text-success" />
                        </button>
                    </div>

                    <p v-if="copied" class="flex items-center gap-1.5 text-xs text-success" role="status">
                        <Icon name="check" class="text-2xs" />{{ t(`sandbox.agentMemory.promptCopied`) }}
                    </p>
                    <p v-if="showPrompt" class="ui-softscroll max-h-48 overflow-y-auto whitespace-pre-wrap border-l-2 border-line pl-3 text-2xs leading-relaxed text-muted">
                        {{ IMPORT_PROMPT }}
                    </p>
                </div>
            </li>

            <!-- 2. Paste: what the other assistant answered. -->
            <li class="flex gap-3">
                <span :class="badge(false)">2</span>
                <div class="flex min-w-0 flex-1 flex-col gap-2">
                    <label for="memory-import-answer" class="flex min-h-6 items-center text-sm font-medium text-content">
                        {{ t(`sandbox.agentMemory.pasteItsAnswer`) }}
                    </label>
                    <div class="ui-field-shell max-h-72 overflow-y-auto px-1 py-0.5">
                        <ProseField
                            id="memory-import-answer"
                            v-model="answer"
                            :placeholder="t(`sandbox.agentMemory.pasteHere`)"
                            class="min-h-24"
                            @keydown.ctrl.enter.prevent="submit"
                            @keydown.meta.enter.prevent="submit"
                        />
                    </div>
                    <Notice v-if="failure !== undefined" :of="failure" />
                </div>
            </li>
        </ol>

        <template #footer>
            <!-- Where it lands, and whether it takes the place of an earlier import. -->
            <span class="mr-auto flex min-w-0 items-center gap-1.5 text-xs text-muted">
                <Icon :name="replaces ? `refresh` : `arrow-right`" class="text-2xs" aria-hidden="true" />
                <span class="truncate">
                    <code class="font-mono">{{ MEMORY_FILE }}</code>
                    <template v-if="replaces"> · {{ t(`sandbox.agentMemory.replacesLastImport`) }}</template>
                </span>
            </span>
            <Button tier="quiet" :label="t(`ui.action.cancel`)" @click="open = false" />
            <Button tier="accent" :label="t(`sandbox.agentMemory.addToMemory`)" :loading="importing" :disabled="!answered" @click="submit">
                <template #icon><Icon name="sparkles" /></template>
            </Button>
        </template>
    </Modal>
</template>
