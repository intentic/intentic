<script setup lang="ts">
import type { SkillDraft, SkillSummary } from "@intentic/api-contract";
import { BrandMark, Button, CopyButton, DisclosureRow, Icon, MarkdownDocument, StatusBadge } from "@intentic/ui";
import ToggleSwitch from "primevue/toggleswitch";
import { computed, ref, watch } from "vue";
import SkillForm from "./SkillForm.vue";
import type { SkillSources } from "./skillVisual";
import { skillVisual } from "./skillVisual";
import { provenanceOf, provenanceVariant } from "./skillWords";
import { useT } from "@intentic/ui/i18n";

// A skill's row expands in place on click, no menu, using <DisclosureRow> for the chevron, ARIA and open wash.
// Delete sits under the fold, confirmed before it fires. Both views, reading another skill and editing your own,
// render on <MarkdownDocument> rather than a raw source block.

const t = useT();

const { skill, expanded, body, bodyError, sources, disabled } = defineProps<{
    skill: SkillSummary;
    expanded: boolean;
    /** The skill's text, once it has arrived. Undefined while the open row is still fetching it. */
    body?: string | undefined;
    bodyError?: string | undefined;
    /** What the extensions and connections say their own marks are; see skillVisual. */
    sources: SkillSources;
    /** True while settings haven't loaded yet; nothing here can be written. */
    disabled: boolean;
}>();

const emit = defineEmits<{
    toggle: [];
    enable: [enabled: boolean];
    save: [SkillDraft];
    remove: [];
}>();

const visual = computed(() => skillVisual(skill, sources));

// The form edits a draft, not the row: provenance stays on the row, and body arrives only once read.
const editing = computed<SkillDraft | undefined>(() =>
    skill.editable && body !== undefined ? { name: skill.name, description: skill.description, body } : undefined,
);

// Confirmation resets whenever the row's open state changes, so it's never left waiting the next time it opens.
const confirmRemove = ref(false);
watch(
    () => expanded,
    () => (confirmRemove.value = false),
);
</script>

<template>
    <!-- Full width: this opens a place to read or edit a file, not evidence attached to the row's name. -->
    <DisclosureRow body="drawer" :open="expanded" @update:open="emit(`toggle`)">
        <template #lead="{ mark }">
            <!-- Dimmed when the skill is off; size and tier come from the enclosing <RowGroup>, not this file. -->
            <BrandMark :size="mark" :name="skill.name" :logo="visual.logo" :icon="visual.icon" :idle="!skill.enabled" />
        </template>

        <template #title>
            <span class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                <span class="shrink-0" :class="skill.enabled ? `text-content` : `text-muted`">{{ skill.name }}</span>
                <StatusBadge :variant="provenanceVariant(skill)" size="xs" :label="provenanceOf(skill)" />
            </span>
        </template>

        <!-- Shown truncated only while closed; the open view states it in full below. -->
        <template v-if="!expanded" #description>
            <span class="block truncate" :class="skill.description === `` ? `italic text-subtle` : ``">
                {{ skill.description === `` ? t(`sandbox.skillRow.noDescriptionAgentRarely`) : skill.description }}
            </span>
        </template>

        <!-- Never dimmed, unlike the rest of an off row: it's the one control that still works. -->
        <template v-if="skill.switchable" #control>
            <ToggleSwitch
                class="ui-switch-sm shrink-0"
                :model-value="skill.enabled"
                :disabled="disabled"
                :aria-label="t(`sandbox.skillRow.enable`, { name: skill.name })"
                @update:model-value="(value: boolean) => emit(`enable`, value)"
            />
        </template>

        <template #below>
            <p v-if="bodyError !== undefined" class="text-2xs text-danger">{{ bodyError }}</p>
            <p v-else-if="body === undefined" class="flex items-center gap-2 text-2xs text-subtle">
                <Icon name="spinner" spin class="text-xs" />
                {{ t(`ui.status.reading`) }}
            </p>
            <template v-else>
                <!-- The reader's own skill: the form is how they read it too. -->
                <SkillForm v-if="editing !== undefined" :skill="editing" :disabled="disabled" @save="emit(`save`, $event)" @cancel="emit(`toggle`)" />
                <div v-else class="flex flex-col gap-3">
                    <div class="flex flex-wrap items-start justify-between gap-x-4 gap-y-2">
                        <!-- States the trigger line in full since the closed row had to cut it; an empty one explains why the agent rarely picks this skill. -->
                        <p class="min-w-0 flex-1 text-2xs" :class="skill.description === `` ? `italic text-subtle` : `text-muted`">
                            {{ skill.description === `` ? t(`sandbox.skillRow.noDescriptionAgentRarely`) : skill.description }}
                        </p>
                        <CopyButton :text="body" :label="t(`ui.action.copy`)" v-tooltip.top="t(`sandbox.skillRow.fileExactlyAuthorWrote`)" />
                    </div>
                    <!-- Read-only rendering, no Read/Source toggle: the markup is already in the DOM, hidden until a caret enters it. -->
                    <MarkdownDocument
                        :model-value="body"
                        :label="t(`sandbox.skillRow.instructions`, { name: skill.name })"
                        class="max-h-96 overflow-auto"
                        style="--prose-measure: 76ch"
                    />
                </div>

                <!-- Always below the active view's own buttons: the destructive action never shares a row with them. -->
                <div v-if="skill.removable" class="mt-3 flex flex-wrap items-center gap-3">
                    <Button
                        v-if="!confirmRemove"
                        size="small"
                        severity="danger"
                        text
                        :label="t(`sandbox.skillRow.deleteSkill`)"
                        :disabled="disabled"
                        @click="confirmRemove = true"
                    />
                    <template v-else>
                        <span class="text-2xs text-muted">{{ t(`sandbox.skillRow.deleteAgentStopsBeing`, { name: skill.name }) }}</span>
                        <Button size="small" severity="danger" :label="t(`ui.action.delete`)" :disabled="disabled" @click="emit(`remove`)" />
                        <Button size="small" severity="secondary" text :label="t(`sandbox.skillRow.keep`)" @click="confirmRemove = false" />
                    </template>
                </div>
            </template>
        </template>
    </DisclosureRow>
</template>
