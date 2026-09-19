<script setup lang="ts">
import { ProjectChip } from "@intentic/ui";
import { computed } from "vue";
import { setProjectScope } from "../../../app/projectScope";
import { workspaceDir } from "../health/workspaceScope";

// Says which project the tree is rooted at, and is the way back to the whole workspace. The project is the shell's
// (app/projectScope.ts), so clearing it here clears it for the agents board and every other view too. Absent on the
// whole tree, which needs no marker; a sibling of the agent scope chip, since both narrow what the same tree shows.
// The tree hides nothing countable (it IS the project), so the chip carries no hidden count here.

// `compact` drops the name below the `lg` breakpoint, which a narrow status strip needs and a full-width row does not:
// on a phone there is no hover to recover it from, so a bar with room says the name.
const { compact = true } = defineProps<{ compact?: boolean }>();

const project = computed(() => (workspaceDir.value === `` ? undefined : workspaceDir.value));
</script>

<template>
    <ProjectChip :project="project" noun="files" :compact="compact" @clear="setProjectScope(undefined)" />
</template>
