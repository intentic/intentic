<script setup lang="ts">
import { computed, ref } from "vue";
import type { TranscriptTool } from "@intentic/sandbox-contract";
import { useChatSurface } from "./chatToolSurface";
import ChatToolCard from "./ChatToolCard.vue";
import { type ToolGroup, groupDiffSummary } from "./toolGrouping";
import { delegates, present } from "./toolPresentation";
import { useT } from "@intentic/ui/i18n";
import { useAudience } from "../../../app/useAudience";
import { plainToolWords } from "../../../lib/toolWords/toolWords";

const t = useT();
const { maker } = useAudience();

/* A collapsed run of consecutive same-name+same-target tool calls. */

const props = defineProps<{
    group: ToolGroup;
    live: boolean;
}>();

// Opens the target chip through the surface the cards underneath it use (ChatToolCard), which also scopes the path.
const openFile = useChatSurface().openFile;

const expanded = ref(false);
const toggle = (): void => {
    expanded.value = !expanded.value;
};

// Use the first tool's presentation for the icon (all tools in the group share the same name).
const icon = computed(() => present(props.group.tools[0]!).icon);
// A run of calls that each started a subagent is named as the subagents they are, as each card is (ChatToolCard).
const name = computed(() => {
    if (delegates(props.group.tools[0]!)) {
        return maker.value ? t(`chat.toolWords.helperName`) : t(`shared.subagent`);
    }
    // Said as the act, as a single call's card says it (ChatToolCard).
    return maker.value ? plainToolWords({ name: props.group.name, target: props.group.target, category: props.group.category }, { file: false }) : props.group.name;
});
const target = computed(() => (maker.value && props.group.category === `execute` ? undefined : props.group.target));

// Whether any tool in the group is still running: shows the spinner instead of the icon.
const running = computed(() => props.group.tools.some((tool) => tool.status === `pending` || tool.status === `in_progress`));

// Whether any tool in the group failed.
const failed = computed(() => props.group.tools.some((tool) => tool.status === `failed`));

const summary = computed(() => groupDiffSummary(props.group.tools));

// The location for the clickable target chip: same as ChatToolCard, from the first tool, and never a command's.
const location = computed(() => {
    const first = props.group.tools[0];
    return first?.category === `execute` ? undefined : first?.locations?.[0];
});
</script>

<template>
    <div class="flex flex-col gap-0.5">
        <!-- A phone's row is 32px rather than its 16px line, and its two presses fill it: the fold and the file were each a
             strip a thumb could not land on. -->
        <div class="group/tool flex min-w-0 items-center gap-1.5 text-2xs text-muted max-md:min-h-8">
            <!-- Chevron in the mark box, glyph and name on the hang: the same edges as a single call's row (ChatToolCard). -->
            <button
                type="button"
                class="flex shrink-0 items-center gap-1.5 self-stretch whitespace-nowrap transition-colors hover:text-content"
                :aria-expanded="expanded"
                @click="toggle"
            >
                <span class="chat-mark mr-0.5"><Icon :name="expanded ? 'chevron-down' : 'chevron-right'" class="text-2xs" /></span>
                <Icon v-if="running && live" name="spinner" :spin="true" class="text-2xs text-link" />
                <Icon v-else :name="icon" class="text-2xs" :class="failed ? 'text-danger' : 'text-link'" />
                <span class="font-medium" :class="failed ? 'text-danger' : 'text-muted'">{{ name }}</span>
            </button>
            <button
                v-if="location && openFile"
                type="button"
                class="min-w-0 self-stretch truncate font-mono transition-colors hover:text-content hover:underline"
                v-tooltip.top="t(`chat.words.openFile`)"
                @click="openFile(location.path, location.line)"
            >
                {{ target ?? location.path }}
            </button>
            <span v-else-if="location || target" class="min-w-0 truncate font-mono">{{ target ?? location?.path }}</span>
            <span class="ml-auto flex shrink-0 items-center gap-2">
                <span v-if="summary" class="tabular-nums" :class="failed ? 'text-danger' : 'text-subtle'">{{ summary }}</span>
                <!-- A count like any other row's figure: plain, subtle, tabular. A pill made it the one boxed number in the run. -->
                <span class="tabular-nums text-subtle">×{{ group.tools.length }}</span>
            </span>
        </div>
        <div v-if="expanded" class="ml-[var(--chat-hang)] flex flex-col gap-1">
            <ChatToolCard v-for="tool in group.tools" :key="tool.id" :tool="tool as TranscriptTool" :live="live" />
        </div>
    </div>
</template>
