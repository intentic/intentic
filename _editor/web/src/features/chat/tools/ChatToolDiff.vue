<script setup lang="ts">
import { computed } from "vue";
import { DiffStat } from "@intentic/ui";
import { type DiffRow, diffRows, diffStat } from "./chatToolDiff";
import { useT } from "@intentic/ui/i18n";

const t = useT();

/* Inline unified diff for one structured diff content entry of a tool card. */

const props = defineProps<{
    path: string;
    oldText?: string;
    newText: string;
    // The daemon clipped a side at the wire cap: the rendered diff may be incomplete.
    truncated?: boolean;
    // Whether the header leads anywhere. False on a conversation published to the public, which has no
    // workspace behind it: the diff is the same record either way, so only the affordance is withdrawn.
    openable?: boolean;
}>();

const emit = defineEmits<{ open: [] }>();

const rows = computed(() => diffRows(props.oldText, props.newText));
const stat = computed(() => diffStat(props.oldText, props.newText));

const gutterOf = (row: DiffRow): string => (row.type === `add` ? `+` : row.type === `del` ? `-` : ` `);
const rowClass = (row: DiffRow): string => {
    if (row.type === `add`) {
        return `bg-success/10 text-success`;
    }
    if (row.type === `del`) {
        return `bg-danger/10 text-danger`;
    }
    if (row.type === `skip`) {
        return `text-subtle`;
    }
    return `text-muted`;
};
</script>

<template>
    <div class="chat-inset ml-4 overflow-hidden">
        <component
            :is="openable ? 'button' : 'div'"
            :type="openable ? 'button' : undefined"
            class="chat-inset-rule flex w-full items-center gap-1.5 px-2.5 py-1.5 text-2xs text-muted transition-colors"
            :class="openable && 'hover:bg-overlay hover:text-content'"
            v-tooltip.top="openable ? t(`chat.words.openInWorkspaceShort`) : undefined"
            @click="openable && emit('open')"
        >
            <Icon name="file-edit" class="text-2xs text-subtle" />
            <span class="min-w-0 flex-1 truncate font-mono">{{ path }}</span>
            <DiffStat :additions="stat.additions" :deletions="stat.deletions" />
            <span v-if="truncated" class="shrink-0 text-subtle">{{ t(`chat.chatToolDiff.truncated`) }}</span>
        </component>
        <pre
            class="max-h-56 overflow-auto py-0.5 text-2xs leading-relaxed"
        ><code v-for="(row, index) in rows" :key="index" class="block whitespace-pre-wrap px-2" :class="rowClass(row)">{{ gutterOf(row) }} {{ row.text }}</code></pre>
    </div>
</template>
