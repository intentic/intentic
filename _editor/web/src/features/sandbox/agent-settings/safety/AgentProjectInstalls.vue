<script setup lang="ts">
import type { ProjectInstallMode } from "@intentic/sandbox-contract";
import { Row, RowGroup, SegmentedControl } from "@intentic/ui";
import { computed } from "vue";
import { useSandboxSettings } from "../../overview/useSandboxSettings";
import { useT } from "@intentic/ui/i18n";

// Whether an agent's own project install (pnpm add, npm install, uv sync) runs, asks first, or is refused. Where it
// lands is the sandbox's business, so this says only whether a person is asked.

const t = useT();

const { settings, patch } = useSandboxSettings();

// Least to most restrictive, the order the judge's switch above reads in.
const MODES = computed(() => [
    { label: t(`sandbox.agentProjectInstalls.automatic`), value: `automatic` },
    { label: t(`sandbox.agentProjectInstalls.ask`), value: `ask` },
    { label: t(`sandbox.agentProjectInstalls.never`), value: `never` },
]);

const mode = computed<ProjectInstallMode>(() => settings.value?.projectInstalls ?? `automatic`);

// One line per answer when the owner is asked or installs are deferred to land; automatic needs no note.
const note = computed(() => {
    if (mode.value === `ask`) {
        return t(`sandbox.agentProjectInstalls.askNote`);
    }
    if (mode.value === `never`) {
        return t(`sandbox.agentProjectInstalls.neverNote`);
    }
    return undefined;
});
</script>

<template>
    <RowGroup :label="t(`sandbox.agentProjectInstalls.title`)">
        <Row icon="box" :title="t(`sandbox.agentProjectInstalls.whenInstalls`)" :description="t(`sandbox.agentProjectInstalls.whetherAsked`)">
            <template #control>
                <SegmentedControl
                    :model-value="mode"
                    :options="MODES"
                    @update:model-value="(projectInstalls: string) => patch({ projectInstalls: projectInstalls as ProjectInstallMode })"
                />
            </template>
            <template v-if="note" #below>
                <p class="text-2xs text-muted">{{ note }}</p>
            </template>
        </Row>
    </RowGroup>
</template>
