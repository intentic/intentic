<script setup lang="ts">
import type { SkillSummary } from "@intentic/sandbox-contract/schemas/settings";
import { BrandMark, ui } from "@intentic/ui";
import ToggleSwitch from "primevue/toggleswitch";
import { computed } from "vue";
import type { SkillSources } from "./skillVisual";
import { skillVisual } from "./skillVisual";
import { useT } from "@intentic/ui/i18n";

// A skill that arrived with something else, as its name and its owner's mark: read for what is there, so a shelf of
// them scans in a line where rows took a screen. Pressing it opens the skill's page. A built-in tool keeps its switch
// beside the name, inside the same pill, since an off one is an offer the reader can take up from here.

const t = useT();

const { skill, sources, disabled } = defineProps<{
    skill: SkillSummary;
    /** What the extensions and connections say their own marks are; see skillVisual. */
    sources: SkillSources;
    disabled: boolean;
}>();

const emit = defineEmits<{ open: []; enable: [enabled: boolean] }>();

const visual = computed(() => skillVisual(skill, sources));
</script>

<template>
    <span data-skill-chip :class="ui.chip({ size: `sm`, lead: true, trail: skill.switchable })" class="relative">
        <button
            type="button"
            class="flex min-w-0 items-center gap-1.5 font-mono outline-none after:absolute after:inset-0 after:rounded-[inherit] focus-visible:after:ring-2 focus-visible:after:ring-primary-500/60"
            :class="skill.enabled ? `` : `text-subtle`"
            :aria-label="t(`sandbox.agentSkills.openSkill`, { name: skill.name })"
            @click="emit(`open`)"
        >
            <BrandMark :size="16" :name="skill.name" :logo="visual.logo" :icon="visual.icon" :idle="!skill.enabled" />
            <span class="truncate">{{ skill.name }}</span>
        </button>
        <ToggleSwitch
            v-if="skill.switchable"
            class="ui-switch-sm relative z-10 ml-1 shrink-0"
            :model-value="skill.enabled"
            :disabled="disabled"
            :aria-label="t(`sandbox.skillRow.enable`, { name: skill.name })"
            @update:model-value="(value: boolean) => emit(`enable`, value)"
        />
    </span>
</template>
