<!-- What the woken agent is told: one document that is read and written in the same place, in the same type. There is no edit
     to start and no Save to press; it writes itself a moment after the typing stops. -->
<script setup lang="ts">
import type { AutomationSummary } from "@intentic/sandbox-contract/schemas/automations";
import { CopyButton, Icon, MarkdownDocument, Section, ui, useDevice } from "@intentic/extension-ui";
import { computed, nextTick, onMounted, ref, watch } from "vue";
import { useAutomationPatch } from "../properties/useAutomationPatch";
import { t } from "../i18n.js";

const props = defineProps<{ automation: AutomationSummary }>();

// The text on screen: seeded from what is stored, and following a change made elsewhere only while it holds nothing of the
// reader's own. The document surface ends its text in the gap after its last block, so "nothing of its own" forgives the
// ends, never a change inside the text.
const draft = ref(props.automation.prompt);
let seeded = props.automation.prompt;
watch(
    () => props.automation.prompt,
    (prompt) => {
        if (draft.value.trim() === seeded.trim()) {
            draft.value = prompt;
        }
        seeded = prompt;
    },
);
// What the document measures "unsaved" against: saved trimmed, so a draft that differs from it only at its ends is saved.
const onDisk = computed(() => (draft.value.trim() === props.automation.prompt.trim() ? draft.value : props.automation.prompt));

const { patch, error, saving } = useAutomationPatch(computed(() => props.automation));
const save = async (text: string): Promise<void> => {
    if (text.trim() === ``) {
        error.value = t(`instructionsSection.empty`);
        return;
    }
    await patch((stored) => ({ ...stored, prompt: text.trim() }));
};

// Folded to a screenful, so a long prompt never buries what comes after it; measured, not guessed from its length, since a
// short prompt with a list can stand taller than a long paragraph. Writing in it unfolds it: the caret is never under a fade.
const box = ref<HTMLElement | null>(null);
// The last lines dissolve into whatever ground the section sits on, in every look.
const FADE = { maskImage: `linear-gradient(to bottom, black calc(100% - 4rem), transparent)` };
const unfolded = ref(false);
const overflowing = ref(false);
const measure = (): void => {
    const element = box.value;
    // Unfolded, nothing overflows, so the last folded reading stands until it folds again.
    if (element === null || unfolded.value) {
        return;
    }
    overflowing.value = element.scrollHeight > element.clientHeight + 1;
};
onMounted(measure);
watch([() => props.automation.prompt, unfolded], () => void nextTick(measure));
const unfoldToWrite = (): void => {
    if (overflowing.value) {
        unfolded.value = true;
    }
};

// A phone writes markdown as its source (the kit's choice for reliable touch editing), which reads far worse than the
// rendered document. So there it reads rendered, and a tap on the text puts the source under the finger, caret placed;
// leaving it renders it again. A pointer has the rendered surface that takes a caret, so it is always live.
const { mobile } = useDevice();
const touching = ref(false);
const editable = computed(() => !mobile.value || touching.value);
const touchToWrite = (event: MouseEvent): void => {
    const target = event.target instanceof Element ? event.target : undefined;
    // A tap that followed a link, pressed a code block's button or selected words is reading, not asking to write.
    if (!mobile.value || touching.value || window.getSelection()?.toString() || target?.closest(`a, button`)) {
        return;
    }
    touching.value = true;
    unfoldToWrite();
    void nextTick(() => box.value?.querySelector(`textarea`)?.focus());
};
const leaveTouch = (event: FocusEvent): void => {
    const next = event.relatedTarget instanceof Node ? event.relatedTarget : null;
    // A refusal stays on screen beside the text it is about.
    if (!mobile.value || box.value?.contains(next) || error.value !== undefined) {
        return;
    }
    touching.value = false;
};
</script>

<template>
    <Section :label="t(`instructionsSection.instructions`)">
        <template #actions>
            <CopyButton :text="automation.prompt" :aria-label="t(`instructionsSection.copy`)" />
        </template>

        <!-- A hover wash says it can be written in, as a value in the column beside does. The wash sits on this wrapper and
             the fade on the document inside it, so a hovered fold stays one clean rectangle. -->
        <div class="-mx-2 rounded-md px-2 py-1 transition-colors hover:bg-content/5" @focusin="unfoldToWrite" @focusout="leaveTouch" @click="touchToWrite">
            <!-- Folded by masking the document itself rather than painting a gradient over it: a painted fade has to guess the
                 ground's colour, and on a drawer, a hover wash or another look it guessed wrong and read as a smudged slab. -->
            <div ref="box" class="overflow-hidden" :class="unfolded ? `` : `max-h-56`" :style="overflowing && !unfolded ? FADE : undefined">
                <MarkdownDocument
                    v-model="draft"
                    :editable="editable"
                    save="auto"
                    frame="none"
                    :stored="onDisk"
                    :saving="saving"
                    :label="t(`instructionsSection.instructions`)"
                    @save="save"
                >
                    <template v-if="error" #note><span class="text-danger">{{ error }}</span></template>
                </MarkdownDocument>
            </div>
        </div>
        <button
            v-if="overflowing || unfolded"
            type="button"
            :class="ui.textButton({ size: `xs`, tone: `quiet` })"
            class="mt-1"
            :aria-expanded="unfolded"
            @click="unfolded = !unfolded"
        >
            {{ unfolded ? t(`instructionsSection.showLess`) : t(`instructionsSection.showAll`) }}
            <Icon :name="unfolded ? `chevron-up` : `chevron-down`" />
        </button>
    </Section>
</template>
