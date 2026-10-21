<script setup lang="ts">
import { Button, DeviceRunLog, Icon, type IconName, toneTint } from "@intentic/ui";
import RunCommand from "../../../../components/RunCommand.vue";
import { spanWords } from "../../../../components/progress/progress";
import { computed, ref } from "vue";
import { type AgentRun, agentRunDetail, agentRunTitle } from "../runners/agentRun";
import { AGENT_RETURN_DEADLINE_MS } from "../runners/deviceWork";
import { useT } from "@intentic/ui/i18n";

// HOW ONE PRESS OF AN AGENT VERB ENDED, drawn where the concern that offered it stood, so the question and its answer
// occupy the same line. Only the ending: while the run is live the environment's own row says so, once, with its one
// spinner (DeviceEnvironment.vue), and a strip here as well was a card inside the row's card with a second spinner, an
// elapsed counter and a deadline paragraph, twice over on a machine whose every side was updating.
//
// A finish is one flat line, since it needs nothing from the reader but a glance. A refusal keeps the tinted block:
// it is the one ending the reader must act on, and it carries the line to type out there. A wait that outlived its
// deadline says so in a line, in place of the spinner the row has now dropped.

const t = useT();

const { run, machine } = defineProps<{
    run: AgentRun;
    /** The machine's name, for the line a refusal offers to type there. */
    machine: string;
}>();

const emit = defineEmits<{ dismiss: [] }>();

const failed = computed(() => run.state === `failed`);
// Still waiting, past its deadline: the only way a strip can be drawn over a run that has not ended.
const overdue = computed(() => run.state === `waiting` || run.state === `running`);
const title = computed(() => (overdue.value ? t(`sandbox.agentRun.notBack`, { limit: spanWords(AGENT_RETURN_DEADLINE_MS) }) : agentRunTitle(run)));
const detail = computed(() => (overdue.value ? undefined : (agentRunDetail(run) ?? (failed.value ? run.failure?.notice.detail : undefined))));
const showing = ref(false);

const ICON = computed((): IconName => (failed.value ? `exclamation-triangle` : overdue.value ? `clock` : `check-circle`));
const GLYPH = computed(() => (failed.value ? `text-danger` : overdue.value ? `text-warning` : `text-success`));
</script>

<template>
    <!-- `alert` when it was refused, the one ending a reader must act on; `status` otherwise. -->
    <div
        class="flex min-w-0 flex-col gap-2"
        :class="failed ? toneTint(`danger`, undefined, `rounded-lg border px-3 py-2.5`) : undefined"
        :role="failed ? `alert` : `status`"
    >
        <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <Icon :name="ICON" class="shrink-0 text-xs" :class="GLYPH" aria-hidden="true" />
            <p class="flex min-w-0 grow basis-48 flex-wrap items-baseline gap-x-2 text-xs">
                <span class="font-medium text-content">{{ title }}</span>
                <span v-if="detail" class="text-muted">{{ detail }}</span>
            </p>
            <div class="ml-auto flex shrink-0 items-center gap-0.5">
                <Button
                    v-if="run.lines.length > 0"
                    size="small"
                    tier="quiet"
                    :label="showing ? t(`sandbox.agentRun.hideOutput`) : t(`sandbox.agentRun.output`)"
                    :aria-expanded="showing"
                    @click="showing = !showing"
                >
                    <template #icon><Icon name="terminal" /></template>
                </Button>
                <Button size="small" tier="quiet" :aria-label="t(`ui.action.dismiss`)" v-tooltip.top="t(`ui.action.dismiss`)" @click="emit(`dismiss`)">
                    <template #icon><Icon name="times" /></template>
                </Button>
            </div>
        </div>
        <DeviceRunLog
            v-if="showing"
            :lines="run.lines"
            :running="false"
            :empty="t(`sandbox.devicePage.startingOnDevice`)"
            :note="t(`sandbox.devicePage.runsOnDeviceKeeps`)"
        />
        <!-- The same act as a line to type out there: the usual reason a press is refused is a route this browser can't open. -->
        <RunCommand v-if="failed && run.failure?.command" :command="run.failure.command" :label="t(`sandbox.deviceOpFailure.runOnYourself`, { machine })" />
    </div>
</template>
