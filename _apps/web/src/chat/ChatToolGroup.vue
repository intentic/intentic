<script setup lang="ts">
import { computed, ref } from "vue";
import type { ChatTool } from "../composables/chat/transcript";
import { openWorkspaceRef } from "../composables/workspace/openFileRef";
import ChatToolCard from "./ChatToolCard.vue";
import { type ToolGroup, groupDiffSummary } from "./toolGrouping";
import { present } from "./toolPresentation";

/* A collapsed run of consecutive same-name+same-target tool calls. The header reads like a single ChatToolCard
 * row — same icon, same target chip, same right-aligned summary — with a count badge and aggregated stats.
 * Expanding reveals the individual cards, indented under a left border like a sub-agent's nested transcript. */

const props = defineProps<{
    group: ToolGroup;
    live: boolean;
}>();

const expanded = ref(false);
const toggle = (): void => {
    expanded.value = !expanded.value;
};

// Use the first tool's presentation for the icon (all tools in the group share the same name).
const icon = computed(() => present(props.group.tools[0]!).icon);

// Whether any tool in the group is still running — shows the spinner instead of the icon.
const running = computed(() => props.group.tools.some((tool) => tool.status === `pending` || tool.status === `in_progress`));

// Whether any tool in the group failed.
const failed = computed(() => props.group.tools.some((tool) => tool.status === `failed`));

const summary = computed(() => groupDiffSummary(props.group.tools));

// The location for the clickable target chip — same as ChatToolCard, from the first tool.
const location = computed(() => props.group.tools[0]?.locations?.[0]);
</script>

<template>
    <div class="flex flex-col gap-0.5">
        <div class="group/tool flex min-w-0 items-center gap-1.5 text-2xs text-muted">
            <button
                type="button"
                class="flex shrink-0 items-center gap-1.5 whitespace-nowrap transition-colors hover:text-content"
                :aria-expanded="expanded"
                @click="toggle"
            >
                <Icon :name="expanded ? 'chevron-down' : 'chevron-right'" class="text-2xs" />
                <Icon v-if="running && live" name="spinner" :spin="true" class="text-2xs text-link" />
                <Icon v-else :name="icon" class="text-2xs" :class="failed ? 'text-danger' : 'text-link'" />
                <span class="font-medium" :class="failed ? 'text-danger' : 'text-muted'">{{ group.name }}</span>
            </button>
            <button
                v-if="location"
                type="button"
                class="min-w-0 truncate font-mono transition-colors hover:text-content hover:underline"
                v-tooltip.top="'Open in workspace'"
                @click="openWorkspaceRef(location.path, location.line)"
            >
                {{ group.target ?? location.path }}
            </button>
            <span v-else-if="group.target" class="min-w-0 truncate font-mono">{{ group.target }}</span>
            <span class="ml-auto flex shrink-0 items-center gap-2">
                <span v-if="summary" class="tabular-nums" :class="failed ? 'text-danger' : 'text-subtle'">{{ summary }}</span>
                <span class="rounded-full bg-overlay px-1.5 py-0.5 text-subtle">×{{ group.tools.length }}</span>
            </span>
        </div>
        <div v-if="expanded" class="ml-4 flex flex-col gap-1 border-l border-line pl-2">
            <ChatToolCard v-for="tool in group.tools" :key="tool.id" :tool="tool as ChatTool" :live="live" />
        </div>
    </div>
</template>
