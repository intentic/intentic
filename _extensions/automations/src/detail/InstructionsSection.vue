<!-- What the woken agent is told: read as the document it is, and written in the same place, in the same type, with nothing to switch to. -->
<script setup lang="ts">
import type { AutomationSummary } from "@intentic/sandbox-contract/schemas/automations";
import { Button, CopyButton, Icon, Markdown, MarkdownDocument, Section, ui } from "@intentic/extension-ui";
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { useAutomationPatch } from "../properties/useAutomationPatch";
import { t } from "../i18n.js";

const props = defineProps<{ automation: AutomationSummary }>();

// Folded to a screenful while read, so a long prompt never buries what comes after it; measured, not guessed from its
// length, since a short prompt with a list can stand taller than a long paragraph.
const box = ref<HTMLElement | null>(null);
const unfolded = ref(false);
const overflowing = ref(false);
const measure = (): void => {
    const element = box.value;
    // Null while the editing surface stands in its place.
    overflowing.value = element !== null && element.scrollHeight > element.clientHeight + 1;
};
onMounted(measure);
watch(
    () => props.automation.prompt,
    () => void nextTick(measure),
);

// Writing it: the same text becomes the editing surface (MarkdownDocument reads and writes in one set of type rules), so
// nothing on the page moves when it starts.
const writing = ref(false);
const draft = ref(``);
const { patch, error, saving } = useAutomationPatch(computed(() => props.automation));
const begin = (): void => {
    draft.value = props.automation.prompt;
    error.value = undefined;
    writing.value = true;
};
// A press that selected words, followed a link or copied a code block is reading, not asking to write.
const beginFromText = (event: MouseEvent): void => {
    const target = event.target instanceof Element ? event.target : undefined;
    if (window.getSelection()?.toString() || target?.closest(`a, button`) !== null) {
        return;
    }
    begin();
};
const save = async (text: string): Promise<void> => {
    if (text.trim() === ``) {
        error.value = t(`instructionsSection.empty`);
        return;
    }
    if (await patch((stored) => ({ ...stored, prompt: text }))) {
        writing.value = false;
        void nextTick(measure);
    }
};
</script>

<template>
    <Section :label="t(`instructionsSection.instructions`)">
        <template #actions>
            <span class="flex items-center gap-1">
                <CopyButton :text="automation.prompt" :aria-label="t(`instructionsSection.copy`)" />
                <button
                    v-if="!writing"
                    type="button"
                    :class="ui.iconButton()"
                    :aria-label="t(`instructionsSection.edit`)"
                    v-tooltip.top="t(`instructionsSection.editShort`)"
                    @click="begin"
                >
                    <Icon name="pencil" class="text-xs" />
                </button>
            </span>
        </template>

        <div v-if="writing" class="flex flex-col gap-2" @keydown.esc="writing = false">
            <MarkdownDocument
                v-model="draft"
                editable
                save="explicit"
                frame="none"
                :stored="automation.prompt"
                :saving="saving"
                :label="t(`instructionsSection.instructions`)"
                @save="save"
            >
                <template #note><span v-if="error" class="text-danger">{{ error }}</span></template>
                <template #actions>
                    <Button :label="t(`automationRow.cancel`)" size="small" tier="quiet" @click="writing = false" />
                </template>
            </MarkdownDocument>
        </div>

        <template v-else>
            <!-- The text is the press target: a hover wash says it can be written in, as a value in the column beside does. -->
            <div class="relative">
                <div
                    ref="box"
                    class="-mx-2 cursor-text overflow-hidden rounded-md px-2 py-1 transition-colors hover:bg-content/5"
                    :class="unfolded ? `` : `max-h-56`"
                    @click="beginFromText"
                >
                    <Markdown :source="automation.prompt" />
                </div>
                <div
                    v-if="overflowing && !unfolded"
                    class="pointer-events-none absolute inset-x-0 bottom-0 h-14 bg-gradient-to-t from-card to-transparent"
                    aria-hidden="true"
                ></div>
            </div>
            <button
                v-if="overflowing || unfolded"
                type="button"
                :class="ui.textButton()"
                class="mt-1 self-start"
                :aria-expanded="unfolded"
                @click="unfolded = !unfolded"
            >
                {{ unfolded ? t(`instructionsSection.showLess`) : t(`instructionsSection.showAll`) }}
            </button>
        </template>
    </Section>
</template>
