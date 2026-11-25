<script setup lang="ts">
import { extensionIdOf } from "@intentic/extension-manifest";
import type { ExtensionSummary } from "@intentic/sandbox-contract/schemas/extension-updates";
import { Button, type IconName, InfoHint, Row, RowGroup, RowNote, type RowTone } from "@intentic/ui";
import { messageOr } from "@intentic/ui/async";
import { computed, onMounted, ref } from "vue";
import { useSandboxScope } from "../../../../client/sandbox/scope/useSandboxScope";
import { startAgent } from "../../../../models/fleet/agentActions";
import { publishBrief } from "../../../../models/sandbox/extensionBrief";
import { useT } from "@intentic/ui/i18n";

// Whether a workspace extension is ready to publish, checked against its files, one check a line, with the way to
// publish once nothing fails. Fetched when the page opens, since it reads the bundle off disk. Only facts answerable
// without running the extension are checked, which the header's (i) says.

const t = useT();

const { extension } = defineProps<{ extension: ExtensionSummary }>();

// The sandbox this page stands in, named on the call rather than whichever one is active when it lands.
const scope = useSandboxScope();
const readiness = ref<{ id: string; label: string; status: string; detail: string }[]>();
const readinessError = ref<string>();
onMounted(async () => {
    readinessError.value = undefined;
    try {
        const result = await scope.rpc.extensions.readiness({ id: extension.id });
        readiness.value = [...result.checks];
    } catch (failure) {
        readiness.value = undefined;
        readinessError.value = messageOr(failure, t(`sandbox.extensionRow.couldNotCheck`));
    }
});

// A check's mark: passed, a warning the author may ship with, or anything else, which blocks.
interface CheckLook {
    readonly icon: IconName;
    readonly tone: RowTone;
}
const lookOf = (status: string): CheckLook => {
    switch (status) {
        case `pass`:
            return { icon: `check-circle`, tone: `success` };
        case `warn`:
            return { icon: `exclamation-triangle`, tone: `warning` };
        default:
            return { icon: `times`, tone: `danger` };
    }
};

// All checks ran and none failed; a warning stays the author's call, not a blocker.
const publishable = computed(() => readiness.value !== undefined && !readiness.value.some((check) => check.status === `fail`));
const publish = (): void => {
    const manifest = extension.manifest;
    // A workspace extension's name is its directory (one per subdirectory), so no round trip is needed.
    startAgent(publishBrief({ id: extensionIdOf(manifest), dir: `.intentic/config/workspace-extensions/${manifest.name}`, name: manifest.name }));
};
</script>

<template>
    <RowGroup v-if="readiness || readinessError" id="extension-publishing" :label="t(`sandbox.extensionRow.publishing`)">
        <template #info>
            <InfoHint :label="t(`sandbox.extensionRow.publishing`)">
                <span class="block text-xs text-content"
                    >{{ t(`sandbox.extensionRow.publishingCaption`) }}. {{ t(`sandbox.extensionRow.publishAgentPushesFiles`) }}</span
                >
            </InfoHint>
        </template>
        <template v-if="publishable" #actions>
            <Button size="small" tier="boring" :label="t(`sandbox.extensionRow.publishWithAgent`)" @click="publish">
                <template #icon><Icon name="sparkles" /></template>
            </Button>
        </template>
        <RowNote v-if="readinessError" icon="exclamation-triangle" tone="danger">{{ readinessError }}</RowNote>
        <Row
            v-for="check in readiness ?? []"
            :key="check.id"
            :icon="lookOf(check.status).icon"
            :tone="lookOf(check.status).tone"
            :title="check.label"
            :description="check.detail"
        />
    </RowGroup>
</template>
