<!-- What decides whether a fire goes ahead: the command it runs first, written where it is read, or the check the sandbox makes itself, with what it saw last. -->
<script setup lang="ts">
import type { Automation, AutomationSummary } from "@intentic/sandbox-contract/schemas/automations";
import { Button, Code, CodeField, formatDateTime, Icon, Section, ui } from "@intentic/extension-ui";
import { computed, ref } from "vue";
import { useAutomationPatch } from "../properties/useAutomationPatch";
import { sourceLabel, watchLine } from "../watch";
import { t } from "../i18n.js";

const props = defineProps<{ automation: AutomationSummary }>();

const watched = computed(() => watchLine(props.automation));

// Only a command is written here: a ready-made check (a package, a release, a page) is a choice of kind and target,
// which the full editor asks for in its own fields.
const writing = ref(false);
const draft = ref(``);
const { patch, error, saving } = useAutomationPatch(computed(() => props.automation));
const begin = (): void => {
    draft.value = props.automation.guard ?? ``;
    error.value = undefined;
    writing.value = true;
};
// Blank removes the check, so every fire goes ahead.
const save = async (): Promise<void> => {
    const guard = draft.value.trim();
    const saved = await patch((stored) => {
        const next: Automation = { ...stored, guard };
        if (guard === ``) {
            delete next.guard;
        }
        return next;
    });
    if (saved) {
        writing.value = false;
    }
};
</script>

<template>
    <Section v-if="automation.guard || automation.source || watched" :label="t(`checkSection.check`)">
        <template v-if="automation.guard && !writing" #actions>
            <button type="button" :class="ui.iconButton()" :aria-label="t(`checkSection.edit`)" v-tooltip.top="t(`instructionsSection.editShort`)" @click="begin">
                <Icon name="pencil" class="text-xs" />
            </button>
        </template>

        <div class="flex flex-col gap-1.5">
            <template v-if="writing">
                <CodeField v-model="draft" lang="bash" :aria-label="t(`checkSection.check`)" @keydown.esc="writing = false" />
                <p class="text-xs text-subtle">{{ t(`checkSection.hint`) }}</p>
                <p v-if="error" class="text-xs break-words text-danger">{{ error }}</p>
                <div class="flex items-center justify-end gap-2">
                    <Button :label="t(`automationRow.cancel`)" size="small" tier="quiet" @click="writing = false" />
                    <Button tier="accent" :label="t(`automationRow.save`)" size="small" :loading="saving" :disabled="saving" @click="save" />
                </div>
            </template>
            <Code v-else-if="automation.guard" :code="automation.guard" lang="bash" wrap :scroll-lines="6" />
            <span v-else-if="automation.source" class="text-sm text-content">{{ sourceLabel(automation.source) }}</span>

            <span v-if="watched && !writing" class="text-xs text-subtle">{{ watched }}</span>
            <template v-if="automation.watch?.value && !writing">
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
