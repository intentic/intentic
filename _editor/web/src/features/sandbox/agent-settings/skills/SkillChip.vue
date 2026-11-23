<script setup lang="ts">
import type { SkillSummary } from "@intentic/sandbox-contract/schemas/settings";
import { BrandMark, Icon, ui } from "@intentic/ui";
import ToggleSwitch from "primevue/toggleswitch";
import { computed } from "vue";
import { isWorkspaceSkill, triggerDoubt } from "./skillList";
import type { SkillSources } from "./skillVisual";
import { marksOnlyOrigin, skillVisual } from "./skillVisual";
import { useT } from "@intentic/ui/i18n";

// One skill, whatever brought it, as its name on a pill: the list is read for what is there, and what a skill says and
// does is its page's to show (SkillPage.vue, opened by a press). A mark only where it tells something the shelf does not
// (a brand, a kind of work), a warning beside a trigger line the reader can fix that names no occasion, and a switch where
// this surface can switch it, kept smaller than the pill it sits in.

const t = useT();

const { skill, sources, disabled } = defineProps<{
    skill: SkillSummary;
    /** What the extensions and connections say their own marks are; see skillVisual. */
    sources: SkillSources;
    disabled: boolean;
}>();

const emit = defineEmits<{ open: []; enable: [enabled: boolean] }>();

const visual = computed(() => skillVisual(skill, sources));
const marked = computed(() => !marksOnlyOrigin(skill, visual.value));

// Only on the reader's own: a doubt about a trigger line nobody here can rewrite is noise.
const doubt = computed(() => {
    const found = isWorkspaceSkill(skill) ? triggerDoubt(skill.description) : undefined;
    return found === `empty` ? t(`sandbox.agentSkills.noTrigger`) : found === `vague` ? t(`sandbox.agentSkills.vagueTrigger`) : undefined;
});
</script>

<template>
    <span data-skill-chip :class="ui.chip()" class="relative">
        <!-- Stretched over the pill, so the whole pill presses and a keyboard reaches it as one button named for the skill. -->
        <button
            type="button"
            class="flex min-w-0 items-center gap-1.5 font-mono outline-none after:absolute after:inset-0 after:rounded-[inherit] focus-visible:after:ring-2 focus-visible:after:ring-primary-500/60"
            :class="skill.enabled ? `` : `text-subtle`"
            @click="emit(`open`)"
        >
            <BrandMark v-if="marked" :size="14" :name="skill.name" :logo="visual.logo" :icon="visual.icon" :idle="!skill.enabled" />
            <span data-skill-name class="truncate">{{ skill.name }}</span>
            <template v-if="doubt !== undefined">
                <Icon name="exclamation-circle" class="text-2xs text-warning" aria-hidden="true" v-tooltip.top="doubt" />
                <span class="sr-only">{{ doubt }}</span>
            </template>
        </button>
        <!-- Above the stretched press, never dimmed: on an off built-in it is the offer to turn it on. -->
        <ToggleSwitch
            v-if="skill.switchable"
            class="ui-switch-xs relative z-10 shrink-0"
            :model-value="skill.enabled"
            :disabled="disabled"
            :aria-label="t(`sandbox.skillRow.enable`, { name: skill.name })"
            @update:model-value="(value: boolean) => emit(`enable`, value)"
        />
    </span>
</template>
