<!-- An agent card's title, the press that opens it, and its rename field while it is being renamed (AgentCard). -->
<script setup lang="ts">
import type { InlineRenameControl } from "@intentic/ui/inline-rename";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import { markSegments } from "../../../../../lib/markSegments";

const props = defineProps<{
    edit: InlineRenameControl;
    title: string;
    // The filter's term, case-folded unless `Aa` is on, so the mark follows the rule the search used.
    needle: string;
    matchCase: boolean;
    // How many lines it may take before it is cut: one on a receipt, two on a live card, three on a slim one.
    lines: 1 | 2 | 3;
    // A mini card's title is a step smaller, as everything on it is.
    small?: boolean;
}>();
// The click rides along: a modified one asks for a chat pane rather than focus.
const emit = defineEmits<{ open: [event: MouseEvent]; enter: [] }>();

const t = useT();
const runs = computed(() => markSegments(props.title, props.needle, props.matchCase));
// `break-words` because a clamp only ellipsises a VERTICAL overrun: one long token (a path, a branch) ran past the edge.
const CLAMP = { 1: `truncate`, 2: `line-clamp-2 break-words leading-snug`, 3: `line-clamp-3 break-words leading-snug` } as const;
</script>

<template>
    <input
        v-if="edit.editing"
        v-model="edit.draft"
        type="text"
        maxlength="80"
        :aria-label="t(`agents.words.agentTitle`)"
        class="ui-field-box ui-field-inline min-w-0 flex-1 basis-0 select-text px-1 font-semibold text-xs"
        @click.stop
        @keydown.enter.stop.prevent="edit.commit()"
        @keydown.esc.stop.prevent="edit.cancel()"
        @blur="edit.blurCommit()"
        @vue:mounted="edit.focusInput"
    />
    <!-- Its whole text in a hover, only while it is cut short. -->
    <button
        v-else
        type="button"
        v-tooltip.top.overflow="title"
        :aria-label="t(`agents.agentCard.focusAgent`, { displayTitle: title })"
        class="min-w-0 flex-1 basis-0 rounded-sm text-left font-semibold text-content"
        :class="[CLAMP[lines], small ? 'text-2xs' : 'text-xs']"
        @click.stop="(event: MouseEvent) => emit(`open`, event)"
        @dblclick.stop="emit(`enter`)"
    >
        <span v-for="(run, at) in runs" :key="at" :class="run.hit ? 'rounded-sm bg-primary-600/30 text-content' : ''">{{ run.text }}</span>
    </button>
</template>
