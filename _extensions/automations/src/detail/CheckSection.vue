<!-- What decides whether a fire goes ahead: the command it runs first, always written where it is read, or the check the sandbox
     makes itself; and under either, what it saw last. Typing in the command moves nothing around it. -->
<script setup lang="ts">
import type { Automation, AutomationSummary } from "@intentic/sandbox-contract/schemas/automations";
import { CodeField, CopyButton, formatDateTime, Section } from "@intentic/extension-ui";
import { computed, onBeforeUnmount, ref, watch } from "vue";
import { useAutomationPatch } from "../properties/useAutomationPatch";
import { sourceLabel, watchLine } from "../watch";
import { t } from "../i18n.js";

const props = defineProps<{ automation: AutomationSummary }>();

const watched = computed(() => watchLine(props.automation));
const stored = computed(() => props.automation.guard ?? ``);

// The command on screen: seeded from what is stored, and following a change made elsewhere only while it holds nothing of
// the reader's own. A ready-made check (a package, a release, a page) is a choice of kind and target, which the full editor
// asks for in its own fields; the daemon refuses a command beside one, so there is no command to write then.
const draft = ref(stored.value);
let seeded = stored.value;
watch(stored, (guard) => {
    if (draft.value.trim() === seeded.trim()) {
        draft.value = guard;
    }
    seeded = guard;
});
const dirty = computed(() => draft.value.trim() !== stored.value.trim());

// "Saved" is a recent event, not a standing fact, so it shows for a moment after a write lands and then goes.
const justSaved = ref(false);
let savedTimer: ReturnType<typeof setTimeout> | undefined;
onBeforeUnmount(() => clearTimeout(savedTimer));

// Written when the reader leaves the field or presses Enter, never mid-word: a half-typed command would be what the next
// fire runs. Blank removes the check, so every fire goes ahead; a fire on change needs a check to compare, so it goes too,
// as the full editor does.
const { patch, error, saving } = useAutomationPatch(computed(() => props.automation));
const save = async (): Promise<void> => {
    if (!dirty.value || saving.value) {
        return;
    }
    const guard = draft.value.trim();
    const saved = await patch((current) => {
        const next: Automation = { ...current, guard };
        if (guard === ``) {
            delete next.guard;
            delete next.fireOn;
        }
        return next;
    });
    if (saved) {
        justSaved.value = true;
        clearTimeout(savedTimer);
        savedTimer = setTimeout(() => (justSaved.value = false), 2000);
    }
};
// Esc puts back what is stored, and leaves the field without writing anything.
const revert = (event: KeyboardEvent): void => {
    draft.value = stored.value;
    error.value = undefined;
    if (event.target instanceof HTMLElement) {
        event.target.blur();
    }
};
// Enter writes it; Shift+Enter is the rare second line. A key that only composes a character is not a press.
const enter = (event: KeyboardEvent): void => {
    if (event.shiftKey || event.isComposing) {
        return;
    }
    event.preventDefault();
    void save();
};

// One line under the field, there only while it has something to say, worst news first.
const foot = computed<{ text: string; tone: string } | undefined>(() => {
    if (error.value !== undefined) {
        return { text: error.value, tone: `text-danger` };
    }
    if (saving.value && dirty.value) {
        return { text: t(`checkSection.saving`), tone: `text-subtle` };
    }
    if (dirty.value) {
        return { text: `${t(`checkSection.hint`)} ${t(`checkSection.keys`)}`, tone: `text-subtle` };
    }
    return justSaved.value ? { text: t(`checkSection.saved`), tone: `text-success` } : undefined;
});
</script>

<template>
    <Section :label="t(`checkSection.check`)">
        <template v-if="automation.guard" #actions>
            <CopyButton :text="automation.guard" :aria-label="t(`checkSection.copy`)" />
        </template>

        <div class="flex flex-col gap-1.5">
            <span v-if="automation.source" class="text-sm text-content">{{ sourceLabel(automation.source) }}</span>
            <template v-else>
                <!-- The block a command is read in, with a caret: the same ground and rim as a code block at rest, the field's
                     own rim colour under a pointer or a caret. -->
                <div class="rounded-md border border-line bg-canvas transition-colors hover:border-line-strong focus-within:border-line-strong">
                    <CodeField
                        v-model="draft"
                        lang="bash"
                        rows="1"
                        :placeholder="t(`automationFields.conditionCaption.none`)"
                        :aria-label="t(`checkSection.check`)"
                        @blur="save"
                        @keydown.enter="enter"
                        @keydown.esc="revert"
                    />
                </div>
                <p v-if="foot" class="text-xs break-words" :class="foot.tone">{{ foot.text }}</p>
            </template>

            <span v-if="watched" class="text-xs text-subtle">{{ watched }}</span>
            <template v-if="automation.watch?.value">
                <span class="mt-1 text-xs text-subtle">{{
                    automation.watch.changedAt === undefined
                        ? t(`automationRow.lastSaw`)
                        : t(`automationRow.lastSawSince`, { when: formatDateTime(automation.watch.changedAt) })
                }}</span>
                <pre class="max-h-32 overflow-auto rounded-md bg-canvas px-2 py-1.5 font-mono text-2xs break-words whitespace-pre-wrap text-muted">{{
                    automation.watch.value
                }}</pre>
            </template>
        </div>
    </Section>
</template>
