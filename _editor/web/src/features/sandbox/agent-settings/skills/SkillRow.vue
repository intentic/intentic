<script setup lang="ts">
import type { SkillDraft, SkillSummary } from "@intentic/sandbox-contract/schemas/settings";
import { BrandMark, CopyButton, DisclosureRow, Icon, MarkdownDocument, ui } from "@intentic/ui";
import ToggleSwitch from "primevue/toggleswitch";
import { computed, nextTick, ref, watch } from "vue";
import SkillDelete from "./SkillDelete.vue";
import SkillEditor from "./SkillEditor.vue";
import type { SkillSources } from "./skillVisual";
import { skillVisual } from "./skillVisual";
import { provenanceOf } from "./skillWords";
import { useT } from "@intentic/ui/i18n";

// A skill's row opens in place on a press, no menu (<DisclosureRow> owns the chevron, ARIA and open wash). Open, your
// own skill is written where it is read (<SkillEditor>); anybody else's is read as the document it is. Where it came
// from is a quiet word beside the switch, not a coloured chip: the list is read for its names, and five chip colours
// down it said nothing a word does not.

const t = useT();

const {
    skill,
    expanded,
    body,
    bodyError,
    sources,
    disabled,
    saving = false,
    saveError,
} = defineProps<{
    skill: SkillSummary;
    expanded: boolean;
    /** The skill's text, once it has arrived. Undefined while the open row is still fetching it. */
    body?: string | undefined;
    bodyError?: string | undefined;
    /** What the extensions and connections say their own marks are; see skillVisual. */
    sources: SkillSources;
    /** True while settings haven't loaded yet; nothing here can be written. */
    disabled: boolean;
    /** A save of this skill is in flight. */
    saving?: boolean;
    /** Why the last save of this skill failed. */
    saveError?: string | undefined;
}>();

const emit = defineEmits<{
    toggle: [];
    enable: [enabled: boolean];
    save: [SkillDraft];
    remove: [];
}>();

const visual = computed(() => skillVisual(skill, sources));
const unnamed = computed(() => skill.description === ``);

// The editor edits a draft, not the row: provenance stays on the row, and body arrives only once read.
const editing = computed<SkillDraft | undefined>(() =>
    skill.editable && body !== undefined ? { name: skill.name, description: skill.description, body } : undefined,
);

// Somebody else's text, folded to a screenful while read so a long one never buries the rows under it. Measured, not
// guessed from its length: a short skill with a list can stand taller than a long paragraph.
const page = ref<HTMLElement | null>(null);
const unfolded = ref(false);
const overflowing = ref(false);
watch(
    () => [body, expanded] as const,
    async () => {
        unfolded.value = false;
        await nextTick();
        overflowing.value = page.value !== null && page.value.scrollHeight > page.value.clientHeight + 1;
    },
    { immediate: true },
);
</script>

<template>
    <!-- Full width: this opens a place to read or write a file, not evidence attached to the row's name. -->
    <DisclosureRow body="drawer" :open="expanded" @update:open="emit(`toggle`)">
        <template #lead="{ mark }">
            <!-- Dimmed when the skill is off; size and tier come from the enclosing <RowGroup>, not this file. -->
            <BrandMark :size="mark" :name="skill.name" :logo="visual.logo" :icon="visual.icon" :idle="!skill.enabled" />
        </template>

        <template #title>
            <span :class="skill.enabled ? `text-content` : `text-muted`">{{ skill.name }}</span>
        </template>

        <!-- Shown truncated only while closed; the open view states it in full, where it is changed. -->
        <template v-if="!expanded" #description>
            <span class="block truncate" :class="unnamed ? `italic text-subtle` : ``">
                {{ unnamed ? t(`sandbox.skillRow.noDescriptionAgentRarely`) : skill.description }}
            </span>
        </template>

        <template #meta>
            <span class="truncate">{{ provenanceOf(skill) }}</span>
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

            <!-- The reader's own skill: written where it is read. -->
            <SkillEditor
                v-else-if="editing !== undefined"
                :skill="editing"
                :disabled="disabled"
                :saving="saving"
                :error="saveError"
                @save="emit(`save`, $event)"
                @cancel="emit(`toggle`)"
            >
                <template v-if="skill.removable" #start>
                    <SkillDelete :name="skill.name" :disabled="disabled || saving" @remove="emit(`remove`)" />
                </template>
            </SkillEditor>

            <!-- Somebody else's: the same two facts in the same places, as text. -->
            <div v-else class="flex flex-col gap-4">
                <div class="flex flex-col gap-0.5">
                    <span class="text-xs text-subtle">{{ t(`sandbox.skillForm.toUse`) }}</span>
                    <p class="min-w-0 flex-1 text-sm" :class="unnamed ? `italic text-subtle` : `text-content`">
                        {{ unnamed ? t(`sandbox.skillRow.noDescriptionAgentRarely`) : skill.description }}
                    </p>
                </div>

                <div class="flex flex-col gap-0.5">
                    <span class="text-xs text-subtle">{{ t(`sandbox.words.instructions`) }}</span>
                    <!-- Faded by a mask rather than a gradient in the card's colour, so it fades the same over the open row's wash. -->
                    <div
                        ref="page"
                        class="overflow-hidden"
                        :class="unfolded ? `` : overflowing ? `max-h-80 [mask-image:linear-gradient(to_bottom,black_70%,transparent)]` : `max-h-80`"
                        style="--prose-measure: 76ch"
                    >
                        <!-- Read-only rendering, no Read/Source toggle: Copy hands over the raw file. -->
                        <MarkdownDocument :model-value="body" :label="t(`sandbox.skillRow.instructions`, { name: skill.name })" />
                    </div>
                    <button
                        v-if="overflowing"
                        type="button"
                        :class="ui.textButton()"
                        class="self-start"
                        :aria-expanded="unfolded"
                        @click="unfolded = !unfolded"
                    >
                        {{ unfolded ? t(`sandbox.skillRow.showLess`) : t(`sandbox.skillRow.showAll`) }}
                    </button>
                </div>

                <div class="flex flex-wrap items-center gap-2">
                    <SkillDelete v-if="skill.removable" :name="skill.name" :disabled="disabled" @remove="emit(`remove`)" />
                    <CopyButton class="ml-auto" :text="body" :label="t(`ui.action.copy`)" v-tooltip.top="t(`sandbox.skillRow.rawFile`)" />
                </div>
            </div>
        </template>
    </DisclosureRow>
</template>
