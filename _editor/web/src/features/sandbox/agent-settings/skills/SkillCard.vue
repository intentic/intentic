<script setup lang="ts">
import type { SkillSummary } from "@intentic/sandbox-contract/schemas/settings";
import ToggleSwitch from "primevue/toggleswitch";
import { computed } from "vue";
import { triggerDoubt, triggerDoubtWords } from "./skillList";
import { provenanceOf } from "./skillWords";
import { useT } from "@intentic/ui/i18n";

// One of the reader's own skills, with room for what decides whether the agent ever opens it: its whole trigger line
// (clamped at three lines, which nearly every one fits), a doubt about that line, and whether turns still reach for it.
// The whole card is one press, opening the skill's page; its switch is the one control that answers without leaving.
// No mark: the card already says whose it is by being a card, and an origin glyph on each said it again.

const t = useT();

const { skill, disabled } = defineProps<{
    skill: SkillSummary;
    /** True while settings haven't loaded yet; the switch can't be written. */
    disabled: boolean;
}>();

const emit = defineEmits<{ open: []; enable: [enabled: boolean] }>();

const unnamed = computed(() => skill.description.trim() === ``);
const doubt = computed(() => (unnamed.value ? undefined : triggerDoubtWords(triggerDoubt(skill.description))));

// The count when there is one; absent on a sandbox from before it, which is not the same as never used.
const used = computed(() => {
    const uses = skill.uses;
    if (uses === undefined) {
        return undefined;
    }
    return uses.week > 0 ? t(`sandbox.skillPage.turnsThisWeek`, { count: uses.week }, uses.week) : t(`sandbox.skillPage.notThisWeek`);
});

// Only a role's kit says where it came from: it reaches that role's turns alone, which the card can't otherwise show.
const scope = computed(() => (skill.origin === `role` ? provenanceOf(skill) : undefined));
</script>

<template>
    <div data-skill-card class="ui-card relative flex flex-col gap-1.5 p-3 transition-colors hover:bg-content/5">
        <div class="flex items-center gap-2">
            <!-- Stretched over the card, so the whole card presses and a keyboard reaches it as one button named for the skill. -->
            <button
                type="button"
                class="min-w-0 flex-1 truncate text-left font-mono text-sm font-medium outline-none after:absolute after:inset-0 after:rounded-[inherit] focus-visible:after:ring-2 focus-visible:after:ring-primary-500/60"
                :class="skill.enabled ? `text-content` : `text-muted`"
                @click="emit(`open`)"
            >
                {{ skill.name }}
            </button>
            <!-- Above the stretched press, never dimmed: it's the one control that still works on an off skill. -->
            <ToggleSwitch
                v-if="skill.switchable"
                class="ui-switch-sm relative z-10 shrink-0"
                :model-value="skill.enabled"
                :disabled="disabled"
                :aria-label="t(`sandbox.skillRow.enable`, { name: skill.name })"
                @update:model-value="(value: boolean) => emit(`enable`, value)"
            />
        </div>
        <p class="line-clamp-3 text-xs" :class="unnamed ? `italic text-warning` : skill.enabled ? `text-muted` : `text-subtle`">
            {{ unnamed ? t(`sandbox.skillRow.noDescriptionAgentRarely`) : skill.description }}
        </p>
        <p v-if="doubt !== undefined" class="text-2xs text-warning">{{ doubt }}</p>
        <p v-if="used !== undefined || scope !== undefined" class="mt-auto flex flex-wrap gap-x-3 text-2xs text-subtle">
            <span v-if="used !== undefined">{{ used }}</span>
            <span v-if="scope !== undefined">{{ scope }}</span>
        </p>
    </div>
</template>
