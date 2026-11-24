<script setup lang="ts">
import { type ActionItem, Button, Icon, OverflowActions, Row, ui } from "@intentic/extension-ui";
import { computed } from "vue";
import { STATUS_TONE } from "../statusVisual";
import { t } from "../i18n.js";
import type { CiFleetService, CiRunner, CiRunnerOp } from "./fleetTypes";
import { RUNNER_OPS, type RunnerPress, runnerDoing, runnerPresses, runnerStatus } from "./runnerFleet";

// One self-hosted runner: its status glyph (a busy one spins as a running run does), its name, what it is doing in
// words, its version, and the presses the fleet service would take for it now. Ops are words on quiet buttons since
// which one applies changes with the runner's state; its log and its removal sit behind icons, as every row's tools do.

const props = defineProps<{
    runner: CiRunner;
    service: CiFleetService;
    // Keys of this runner's presses in flight (`opKey`'s last segment): start, stop, drain, restart, remove.
    pending: ReadonlySet<string>;
    now: number;
}>();
const emit = defineEmits<{ op: [op: CiRunnerOp]; logs: []; remove: [] }>();

const tone = computed(() => STATUS_TONE[runnerStatus(props.runner)]);
const doing = computed(() => runnerDoing(props.runner, props.now));
const presses = computed(() => runnerPresses(props.runner, props.service));
const ops = computed(() =>
    RUNNER_OPS.flatMap((op) => {
        const press: RunnerPress | undefined = presses.value[op];
        return press === undefined ? [] : [{ op, press }];
    }),
);
// Built when read, so the words follow the language on screen. Start and stop say what they are; drain and restart
// say what they wait for.
const opTip = (op: CiRunnerOp): string | undefined => {
    if (op === `drain`) {
        return t(`runners.action.drainTip`);
    }
    return op === `restart` ? t(`runners.action.restartTip`) : undefined;
};
const tipOf = (op: CiRunnerOp, press: RunnerPress): string | undefined => press.reason ?? opTip(op);

const tools = computed<ActionItem[]>(() => [
    { id: `logs`, label: t(`runners.action.logs`), icon: `terminal`, run: () => emit(`logs`) },
    {
        id: `remove`,
        label: t(`runners.action.remove`),
        icon: `trash`,
        danger: true,
        disabled: !presses.value.remove.enabled || props.pending.has(`remove`),
        hint: presses.value.remove.reason ?? t(`runners.action.remove`),
        run: () => emit(`remove`),
    },
]);
</script>

<template>
    <Row>
        <template #lead="{ iconClass }">
            <Icon :name="tone.icon" :spin="tone.spin" class="shrink-0" :class="[iconClass, tone.text]" v-tooltip.top="runner.state" />
        </template>
        <template #title>
            <span class="flex min-w-0 items-center gap-2">
                <span class="min-w-0 truncate font-mono text-sm font-medium text-content">{{ runner.name }}</span>
                <span v-if="runner.light" :class="ui.chip({ size: `sm` }, `shrink-0 text-subtle`)" v-tooltip.top="t(`runners.lightTip`)">{{
                    t(`runners.light`)
                }}</span>
            </span>
        </template>
        <template #description>
            <span class="min-w-0 truncate" :class="runner.state === `not-installed` || runner.state === `failed` ? `text-danger` : `text-subtle`">{{
                doing
            }}</span>
        </template>
        <template #control>
            <div class="ml-auto flex shrink-0 items-center gap-2">
                <span v-if="runner.version" class="font-mono text-2xs text-subtle">v{{ runner.version }}</span>
                <div class="flex items-center gap-1">
                    <!-- The span carries the tooltip: a disabled button takes no hover, and its reason is the point. -->
                    <span v-for="item in ops" :key="item.op" v-tooltip.top="tipOf(item.op, item.press)">
                        <Button
                            :label="t(`runners.action.${item.op}`)"
                            size="small"
                            tier="quiet"
                            :loading="pending.has(item.op)"
                            :disabled="!item.press.enabled || pending.size > 0"
                            @click="emit(`op`, item.op)"
                        />
                    </span>
                    <OverflowActions :actions="tools" :header="runner.name" :button-class="ui.iconButton({ size: `md` })" />
                </div>
            </div>
        </template>
    </Row>
</template>
