<script setup lang="ts">
import type { IgnoredOutput, IgnoredOutputKind } from "@intentic/sandbox-contract";
import { Button, formatBytes } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";

// What the conversation wrote that the repository's ignore rules exclude (a render in `out/`, a build in `dist/`): no
// land carries it, so each file is offered on its own row to copy into the owner's tree, and all of them at once.
// Beside the scratch report and drawn like it, but apart: these are left out because the repository says so, and the
// way out is a copy beside git rather than joining the work.

const t = useT();

export type IgnoredGroup = { readonly repo: string; readonly paths: readonly IgnoredOutput[]; readonly more?: number };

const props = defineProps<{
    ignored: readonly IgnoredGroup[];
    // A land, include, delete or copy this panel has in flight.
    busy: boolean;
    // The copy is a running turn's working state, so nothing is copied out of it until the turn ends.
    streaming: boolean;
}>();

const emit = defineEmits<{ copy: [groups: { repo: string; paths: string[] }[]] }>();

const listed = computed(() => props.ignored.reduce((total, group) => total + group.paths.length, 0));
const more = computed(() => props.ignored.reduce((total, group) => total + (group.more ?? 0), 0));
const count = computed(() => listed.value + more.value);

// Each wording spelled as its own call, so the catalog check can see every message asked for.
const KINDS = {
    new: () => t(`agents.agentIgnoredReport.new`),
    changed: () => t(`agents.agentIgnoredReport.changed`),
} satisfies Record<IgnoredOutputKind, () => string>;

const labelOf = (repo: string, path: string): string => (repo === `root` ? path : `${repo}/${path}`);

const copyAll = (): void => {
    emit(
        `copy`,
        props.ignored.filter((group) => group.paths.length > 0).map((group) => ({ repo: group.repo, paths: group.paths.map((output) => output.path) })),
    );
};
</script>

<template>
    <!-- Quiet like the scratch report: nothing failed, and the work above lands without these. -->
    <div class="flex shrink-0 flex-col gap-1.5 rounded-md border border-border bg-overlay px-2 py-1.5">
        <div class="flex flex-wrap items-center gap-x-2 gap-y-1">
            <span class="inline-flex min-w-0 flex-1 items-center gap-1 text-2xs font-medium text-content">
                <Icon name="eye-slash" class="text-2xs text-subtle" />{{ t(`agents.agentIgnoredReport.title`, { count }, count) }}
            </span>
            <Button v-if="listed > 1" size="small" tier="boring" class="whitespace-nowrap" :disabled="busy || streaming" @click="copyAll">
                {{ t(`agents.agentIgnoredReport.copyAll`) }}
            </Button>
        </div>
        <p class="text-2xs text-muted">{{ t(`agents.agentIgnoredReport.hint`) }}</p>
        <template v-for="group in ignored" :key="group.repo">
            <div v-for="output in group.paths" :key="`${group.repo}:${output.path}`" class="flex flex-wrap items-center gap-x-2 gap-y-1">
                <span class="break-all font-mono text-2xs text-content">{{ labelOf(group.repo, output.path) }}</span>
                <span class="text-2xs text-subtle">{{ KINDS[output.kind]() }} · {{ formatBytes(output.bytes) }}</span>
                <span class="flex-1"></span>
                <Button
                    size="small"
                    tier="boring"
                    class="whitespace-nowrap"
                    :disabled="busy || streaming"
                    @click="emit('copy', [{ repo: group.repo, paths: [output.path] }])"
                >
                    {{ t(`agents.agentIgnoredReport.copy`) }}
                </Button>
            </div>
        </template>
        <p v-if="more > 0" class="text-2xs text-subtle">{{ t(`agents.agentIgnoredReport.more`, { count: more }, more) }}</p>
    </div>
</template>
