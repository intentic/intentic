<script setup lang="ts">
import { Button, DisclosureRow, Notice, RowGroup, StatusBadge } from "@intentic/ui";
import { computed, ref } from "vue";
import { useManifestProblems } from "../../extensions/useManifestProblems";
import { openWorkspaceRef } from "../../../workspace/files/refs/openFileRef";
import { type ManifestRepairAction, manifestNotices } from "./manifestNotice";
import { useOperation } from "../../../../workbench/operations/operations";
import { useT } from "@intentic/ui/i18n";

// Reports problems in the sandbox's own state files (a value it couldn't read, an unknown key), unlike
// SandboxBehindCard, which compares this app's build against the daemon's. A collapsed row shows only a file name
// and a status tag; the diagnosis and any fix sit behind the row's chevron until asked for.

const t = useT();

const { reports, hasProblems, repair } = useManifestProblems();

const notices = computed(() => manifestNotices(reports.value));

// Which rows are open, by path; none are open on arrival, so a row starts as just a name and a tag.
const opened = ref<Record<string, boolean>>({});
const toggle = (path: string, open: boolean): void => {
    opened.value = { ...opened.value, [path]: open };
};

// One run for the whole card, in the operations ledger: no per-row state, a press while one is out is ignored, and a
// refusal is still under its row when the card is opened again. Quiet: a repair that took makes its row disappear.
const repairing = useOperation(`sandbox/manifest/repair`);
const busy = repairing.busy;
const repairNotice = repairing.failure;
// Path of the last press, carried as the run's tag, so a refusal renders under that row instead of at the bottom.
const acting = computed(() => repairing.operation.value?.tag);
const applyRepair = async (path: string, action: ManifestRepairAction): Promise<void> => {
    if (busy.value) {
        return;
    }
    await repairing.run({
        what: action.spoken,
        tag: path,
        failed:
            action.to === undefined
                ? t(`sandbox.sandboxManifestCard.couldntRemoveKey`, { key: action.key })
                : t(`sandbox.sandboxManifestCard.couldntRenameKey`, { key: action.key }),
        quiet: true,
        task: () => repair({ path, key: action.key, ...(action.to === undefined ? {} : { to: action.to }) }),
    });
};
</script>

<template>
    <RowGroup v-if="hasProblems" :label="t(`sandbox.sandboxManifestCard.someSettingsArentBeing`)">
        <DisclosureRow
            v-for="notice in notices"
            :key="notice.path"
            icon="exclamation-triangle"
            tone="warning"
            hit="pair"
            :open="opened[notice.path] === true"
            @update:open="toggle(notice.path, $event)"
        >
            <template #title>
                <span class="flex flex-wrap items-center gap-2">
                    <button
                        type="button"
                        class="cursor-pointer rounded-sm text-left font-mono text-xs hover:text-link hover:underline"
                        v-tooltip.top="notice.path"
                        @click="void openWorkspaceRef(notice.path)"
                    >
                        {{ notice.file }}
                    </button>
                    <!-- Beside the name, not the row's far edge, since it's a fact about this file. -->
                    <StatusBadge variant="neutral" size="xs" :label="notice.impact" />
                </span>
            </template>
            <template #below>
                <div class="flex flex-col gap-1 pb-1 text-2xs">
                    <!-- Actions stay beside the facts they answer. -->
                    <div v-for="(line, index) in notice.lines" :key="index" class="flex flex-wrap items-baseline gap-x-2 gap-y-1">
                        <p class="text-muted">{{ line.text }}</p>
                        <!-- Actions stack on narrow panels to prevent split-row misclicks. -->
                        <span v-if="line.repairs.length > 0" class="flex flex-wrap items-center gap-2">
                            <Button
                                v-for="action in line.repairs"
                                :key="action.label"
                                size="small"
                                tier="boring"
                                :label="action.label"
                                :aria-label="action.spoken"
                                :disabled="busy"
                                @click="void applyRepair(notice.path, action)"
                            />
                        </span>
                    </div>
                    <!-- Outranks the diagnosis: the one line here that requires action. -->
                    <p v-if="notice.fix !== undefined" class="text-content">{{ notice.fix }}</p>
                    <!-- Only refusals show here; a successful repair makes the row disappear, so a banner would repeat what's already visible. -->
                    <Notice v-if="repairNotice && acting === notice.path" :of="repairNotice" />
                </div>
            </template>
        </DisclosureRow>
    </RowGroup>
</template>
