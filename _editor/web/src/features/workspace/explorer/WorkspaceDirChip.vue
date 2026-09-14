<script setup lang="ts">
import { Icon } from "@intentic/ui";
import { computed } from "vue";
import { basename } from "@intentic/ui/path";
import { workspaceDir } from "../health/workspaceScope";

// Says which folder the tree is rooted at, and is the way back to the whole workspace. Absent on the whole tree,
// which needs no marker; a sibling of the agent scope chip, since both narrow what the same tree shows.

const name = computed(() => basename(workspaceDir.value));
const hint = computed(() => `Showing only ${workspaceDir.value}. Click to show the whole workspace.`);
</script>

<template>
    <button
        v-if="workspaceDir !== ``"
        type="button"
        class="ui-chip ui-chip-on h-6 shrink-0 px-1.5"
        :aria-label="hint"
        v-tooltip.bottom="hint"
        @click="workspaceDir = ``"
    >
        <Icon name="folder-open" class="shrink-0 text-[0.7rem]" />
        <span class="max-w-28 truncate max-lg:hidden">{{ name }}</span>
        <Icon name="times" class="shrink-0 text-[0.6rem] opacity-70" />
    </button>
</template>
