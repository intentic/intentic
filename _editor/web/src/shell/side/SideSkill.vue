<script setup lang="ts">
import { computed } from "vue";
import SkillPage from "../../features/sandbox/agent-settings/skills/SkillPage.vue";
import { SKILL_SIDE_VIEW, SkillSideInputSchema, skillSideInput } from "../../features/sandbox/agent-settings/skills/skillSide";
import { FILE_SIDE_VIEW, fileSideInput } from "../../workbench/side/sideFileInput";
import { closeTabs, keepTab, openBeside, type SideInput, sideTabId } from "../../workbench/side/sideTabs";
import { revealSideView } from "../../workbench/side/sideViews";

// A skill's page beside the section: opened from Settings as a look the next press replaces, kept once something is typed
// into it or a file of its folder is opened from it, closed when the skill is deleted, and turned into the saved skill's
// tab, in its place on the strip, when a new one is added.

const { input } = defineProps<{ input: SideInput }>();

const parsed = computed(() => SkillSideInputSchema.safeParse(input).data);
const tabId = computed(() => sideTabId(SKILL_SIDE_VIEW, input));

const keep = (): void => keepTab(tabId.value);

// A file of the folder opens as a file tab beside this one, which stays: a look would otherwise replace this page.
const openFile = (path: string): void => {
    keep();
    revealSideView(FILE_SIDE_VIEW, fileSideInput(path, undefined));
};

const onSaved = (name: string): void => openBeside(SKILL_SIDE_VIEW, skillSideInput(name, name), { keep: true, replace: tabId.value });
</script>

<template>
    <SkillPage
        v-if="parsed !== undefined"
        :key="parsed.skill"
        :skill="parsed.skill"
        :name="parsed.name"
        @edited="keep"
        @open-file="openFile"
        @saved="onSaved"
        @gone="closeTabs(new Set([tabId]))"
    />
</template>
