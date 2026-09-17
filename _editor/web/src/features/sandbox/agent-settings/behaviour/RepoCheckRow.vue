<script setup lang="ts">
import type { RepoChecksSummary } from "@intentic/sandbox-contract";
import { Row } from "@intentic/ui";
import ToggleSwitch from "primevue/toggleswitch";
import RuleCommand from "../safety/RuleCommand.vue";
import { useT } from "@intentic/ui/i18n";

const t = useT();

/* ONE REPOSITORY'S OWN CHECKS, as a row. */

const {
    entry,
    busy = false,
    disabled = false,
} = defineProps<{
    entry: RepoChecksSummary;
    // This row's own write is in flight; the switch goes quiet rather than the whole page.
    busy?: boolean;
    disabled?: boolean;
}>();

const emit = defineEmits<{ switch: [boolean] }>();

// "root" is the workspace's own repository, which nobody calls "root" when they mean it.
const name = (): string => (entry.repo === `root` ? `This workspace` : entry.repo);

const whenWords = (when: string): string => (when === `push` ? `before a push` : `before a turn ends`);
</script>

<template>
    <!-- Dimmed while it is merely declared, like a disabled rule: nothing here is running. -->
    <Row icon="shield" :title="name()" :class="{ 'opacity-60': !entry.adopted && !entry.changed }">
        <template #description>
            <span v-if="entry.error !== undefined" class="mt-1 block text-2xs text-danger">{{
                t(`sandbox.repoCheckRow.checksFileCouldNot`, { error: entry.error })
            }}</span>
            <span v-else class="mt-2 flex flex-col gap-1.5 text-2xs">
                <span v-for="(check, index) in entry.checks" :key="index" class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
                    <span class="shrink-0 text-subtle">{{ whenWords(check.when) }}</span>
                    <!-- The command wraps so the approval target remains fully readable. -->
                    <span class="min-w-0 max-w-full rounded border border-line-subtle bg-canvas/80 px-2 py-0.5">
                        <RuleCommand :command="check.run" wrap />
                    </span>
                    <!-- Repo-relative, as the file spells them; the daemon is the one that prefixes the repository. -->
                    <span v-if="(check.paths?.length ?? 0) > 0" class="inline-flex min-w-0 flex-wrap items-center gap-1.5 text-muted">
                        <span class="shrink-0 text-subtle">{{ t(`sandbox.repoCheckRow.onlyTouching`) }}</span>
                        <span
                            v-for="glob in check.paths"
                            :key="glob"
                            class="max-w-48 truncate rounded border border-line-subtle bg-overlay px-2 py-0.5 font-mono text-content"
                            :title="glob"
                        >
                            {{ glob }}
                        </span>
                    </span>
                </span>
            </span>
        </template>
        <template #meta>{{ entry.path }}</template>
        <template #control>
            <ToggleSwitch
                :model-value="entry.adopted"
                :disabled="disabled || busy || entry.checks.length === 0"
                :aria-label="t(`sandbox.repoCheckRow.runChecksDeclares`, { name: name() })"
                @update:model-value="(value: boolean) => emit(`switch`, value)"
            />
        </template>
        <!-- The two states worth a sentence of their own. -->
        <template v-if="entry.changed || (!entry.adopted && entry.checks.length > 0)" #below>
            <p class="text-2xs" :class="entry.changed ? `text-warning` : `text-subtle`">
                <template v-if="entry.changed">
                    {{ t(`sandbox.repoCheckRow.changedSinceSwitchedOn`) }}
                </template>
                <template v-else>{{ t(`sandbox.repoCheckRow.declaredNotRunningNothing`) }}</template>
            </p>
        </template>
    </Row>
</template>
