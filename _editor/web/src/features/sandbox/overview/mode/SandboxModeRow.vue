<!-- HOW THIS SANDBOX RUNS (settings `mode`, @intentic/constants sandbox-mode.ts), the first of the Overview's facts: hands-off,
     where Intentic handles the code, or hands-on, where the reader does. For a maintainer (settings writes are maintainer
     and up at the daemon) "Change" opens the question the sandbox was made with, anchored to the row, with what the switch
     would change said under the pick before Save. Below maintainer the row is read only. Absent on a daemon whose settings
     predate the mode, which would drop the field. -->
<script setup lang="ts">
import type { SandboxMode } from "@intentic/constants";
import { Button, Notice, ResponsiveOverlay } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed, ref, useId, watch } from "vue";
import { useRole } from "../../../../client/sandbox/useRole";
import { modeSwitchLines, useSandboxMode } from "../../../../models/sandbox/mode/useSandboxMode";
import ModeChoice from "../../../../parts/sandbox/ModeChoice.vue";
import OverviewSettingRow from "../OverviewSettingRow.vue";

const t = useT();
const { canShip } = useRole();
const { mode, settings, switchTo, saving, refusal } = useSandboxMode();

const summary = computed(() => (mode.value === `hands-off` ? t(`sandbox.mode.handsOff.summary`) : t(`sandbox.mode.handsOn.summary`)));

const open = ref(false);
const anchor = ref<HTMLElement>();
const draft = ref<SandboxMode>(`hands-on`);
// Each opening starts from what the sandbox runs as now, so a pick abandoned with Cancel is not waiting next time.
watch(open, (opened) => {
    if (opened && mode.value !== undefined) {
        draft.value = mode.value;
    }
});
const lines = computed(() => (mode.value === undefined ? [] : modeSwitchLines(mode.value, draft.value, settings.value?.rules ?? [])));
const questionId = useId();

const save = async (): Promise<void> => {
    if (await switchTo(draft.value)) {
        open.value = false;
    }
};
</script>

<template>
    <OverviewSettingRow v-if="mode !== undefined" data-setting="overview-mode" :label="t(`sandbox.mode.howItRuns`)">
        <span class="min-w-0 break-words">{{ summary }}</span>
        <template v-if="canShip" #action>
            <span ref="anchor" class="inline-flex">
                <Button size="small" tier="boring" :label="t(`sandbox.sandboxOverview.change`)" @click="open = true" />
            </span>
            <ResponsiveOverlay v-model="open" :anchor="anchor" :header="t(`sandbox.mode.question`)" side="bottom" cross="end" panel-class="w-pop p-4">
                <div class="flex flex-col gap-3" data-sandbox-mode-editor>
                    <span :id="questionId" class="text-sm font-medium text-content">{{ t(`sandbox.mode.question`) }}</span>
                    <ModeChoice v-model="draft" :labelled-by="questionId" />
                    <ul v-if="lines.length > 0" class="flex list-disc flex-col gap-1 pl-4 text-xs text-muted">
                        <li v-for="line in lines" :key="line">{{ line }}</li>
                    </ul>
                    <Notice v-if="refusal" :of="refusal" />
                    <div class="flex items-center justify-end gap-2 border-t border-line-subtle pt-3">
                        <Button :label="t(`ui.action.cancel`)" size="small" tier="quiet" @click="open = false" />
                        <Button tier="accent" :label="t(`ui.action.save`)" size="small" :loading="saving" :disabled="draft === mode || saving" @click="save" />
                    </div>
                </div>
            </ResponsiveOverlay>
        </template>
    </OverviewSettingRow>
</template>
