<script setup lang="ts">
import type { ScratchPath, ScratchReason } from "@intentic/sandbox-contract";
import { Button, formatBytes } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";

// What a land leaves in the conversation's copy because it looks like scratch, one row per entry with why, so a file
// that only looked like scratch can join the work and the rest can go before the copy does.

const t = useT();

const props = defineProps<{
    scratch: readonly { readonly repo: string; readonly paths: readonly ScratchPath[] }[];
    // A land, include or delete this panel has in flight.
    busy: boolean;
    // The copy is a running turn's working state, so neither action reaches it until the turn ends.
    streaming: boolean;
}>();

const emit = defineEmits<{ include: [repo: string, paths: string[]]; delete: [repo: string, paths: string[]] }>();

const count = computed(() => props.scratch.reduce((total, group) => total + group.paths.length, 0));

// Each wording spelled as its own call, so the catalog check can see every message asked for.
const REASONS: Readonly<Record<ScratchReason, () => string>> = {
    hidden: () => t(`agents.agentScratchReport.hidden`),
    byproduct: () => t(`agents.agentScratchReport.byproduct`),
    checkout: () => t(`agents.agentScratchReport.checkout`),
    oversized: () => t(`agents.agentScratchReport.oversized`),
    root: () => t(`agents.agentScratchReport.root`),
};

// Undefined for a checkout of its own, which the daemon does not walk.
const sizeOf = (entry: ScratchPath): string | undefined =>
    entry.files === undefined ? undefined : t(`agents.agentScratchReport.size`, { count: entry.files, size: formatBytes(entry.bytes) }, entry.files);

const labelOf = (repo: string, path: string): string => (repo === `root` ? path : `${repo}/${path}`);
</script>

<template>
    <!-- Quiet on purpose: nothing failed, and the work above lands without these. -->
    <div class="flex shrink-0 flex-col gap-1.5 rounded-md border border-border bg-overlay px-2 py-1.5">
        <span class="inline-flex items-center gap-1 text-2xs font-medium text-content">
            <Icon name="filter" class="text-2xs text-subtle" />{{ t(`agents.agentScratchReport.title`, { count }, count) }}
        </span>
        <p class="text-2xs text-muted">{{ t(`agents.agentScratchReport.hint`) }}</p>
        <template v-for="group in scratch" :key="group.repo">
            <div v-for="entry in group.paths" :key="`${group.repo}:${entry.path}`" class="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span class="break-all font-mono text-2xs text-content">{{ labelOf(group.repo, entry.path) }}</span>
                <span class="text-2xs text-subtle">
                    {{ REASONS[entry.reason]() }}<template v-if="sizeOf(entry) !== undefined"> · {{ sizeOf(entry) }}</template>
                </span>
                <span class="flex-1"></span>
                <!-- A checkout of its own cannot ride a merge, so it only ever leaves. -->
                <Button
                    v-if="entry.reason !== 'checkout'"
                    size="small"
                    severity="secondary"
                    class="whitespace-nowrap"
                    :disabled="busy || streaming"
                    @click="emit('include', group.repo, [entry.path])"
                    v-tooltip.bottom="t(`agents.agentScratchReport.includeHint`)"
                >
                    {{ t(`agents.agentScratchReport.include`) }}
                </Button>
                <Button
                    size="small"
                    severity="secondary"
                    :text="true"
                    class="whitespace-nowrap"
                    :disabled="busy || streaming"
                    @click="emit('delete', group.repo, [entry.path])"
                >
                    <Icon name="trash" />{{ t(`agents.agentScratchReport.delete`) }}
                </Button>
            </div>
        </template>
    </div>
</template>
