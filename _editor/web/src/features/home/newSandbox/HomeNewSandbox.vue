<!-- THE NEW SANDBOX'S PAGE, in the chat's place on Home while its tile is selected (newSandbox.ts says why the run is
     here and its form is a dialog): the app's install, a machine's steps or a machine of ours starting, then the sandbox's
     first start, after which the reader is taken into the sandbox (lib/foundOnComputer.ts). Shown only once the press went somewhere; a press
     refused after that (a machine of ours that would not start) is the dialog's again, with the reason. A setup left
     unfinished, being finished, has no dialog to go back to: its page stands from the press, saying why a code was
     refused when one was. The run is the host's (NewSandboxHost.vue), so another tile pressed meanwhile leaves it going.
     READ AT A GLANCE (2026-11-22): the sandbox's face and name, where it is being made, and how far it has got (the step
     it is on of how many, its percent, the time left) in one header, read off the run's gauge (newSandboxGauge.ts), with
     the lane's own steps under it. It used to say "Setting up workspace" and then "Setting it up on ada-pc" over a column
     of the smallest type, its whereabouts and its percent in neither. A run that needs the reader says so in the header's
     tone; one that stopped says so there, what went wrong in the lane's own words under it, and then the way on. -->
<script setup lang="ts">
import { Button, Notice, Page, SandboxLogo } from "@intentic/ui";
import { useT } from "@intentic/ui/i18n";
import { computed } from "vue";
import AddSandboxRun from "../../setup/add/AddSandboxRun.vue";
import { newSandbox, readNewSandbox } from "./newSandbox";
import { gaugePercent, gaugePosition } from "./newSandboxGauge";

const t = useT();
const run = computed(() => newSandbox.value);
const reading = computed(() => readNewSandbox(run.value));
const phase = computed(() => reading.value?.phase);
// Named as the sandbox it will be, as the tile is.
const named = computed(() => (reading.value?.name === `` || reading.value === undefined ? t(`home.newSandbox.title`) : reading.value.name));
const started = computed(() => run.value?.here.add.started.value);
const resumed = computed(() => run.value?.resumed.value === true);
const refusal = computed(() => (started.value === undefined ? (run.value?.here.add.error.value ?? null) : null));
const title = computed(() => (phase.value === `failed` ? t(`home.newSandbox.toast.failed`, { name: named.value }) : t(`home.newSandbox.settingUp`, { name: named.value })));
// Where it is being made, in the reader's words for the pick they made.
const where = computed((): string | undefined => {
    const lane = started.value;
    switch (lane?.kind) {
        case `here`:
            return t(`home.newSandbox.where.here`);
        case `machine`:
            return t(`home.newSandbox.where.machine`, { machine: lane.door.machineLabel });
        case `hosted`:
            return t(`home.newSandbox.where.hosted`);
        case `command`:
            return t(`home.newSandbox.where.command`);
        case `attach`:
            return t(`home.newSandbox.where.attach`);
        default:
            return undefined;
    }
});
// How far, while it runs: its percent beside the title, and its step and time left under it.
const gauge = computed(() => (phase.value === `running` ? reading.value?.gauge : undefined));
const percent = computed(() => gaugePercent(gauge.value));
const progressLine = computed(() =>
    [gaugePosition(gauge.value), gauge.value?.step, gauge.value?.remaining].filter((part): part is string => part !== undefined && part !== ``).join(` · `),
);
const machineFailed = computed(() => started.value?.kind === `machine` && run.value?.here.add.onMachine.run.failure.value !== undefined);
// Pressed again where it can be: a machine that stopped, or a setup left unfinished whose code was refused.
const retried = computed(() => machineFailed.value || (resumed.value && refusal.value !== null));
</script>

<template>
    <section class="flex min-h-0 min-w-0 flex-1 flex-col" :aria-label="title" data-home-new-sandbox>
        <div class="min-h-0 flex-1 overflow-y-auto">
            <Page v-if="run && reading && (started || resumed)">
                <div class="mx-auto flex w-full max-w-xl flex-col gap-6 py-8">
                    <header class="flex items-start gap-4" :data-phase="phase">
                        <span class="flex size-14 shrink-0 items-center justify-center rounded-2xl bg-content/5">
                            <SandboxLogo :image="null" :name="named" :size="40" />
                        </span>
                        <div class="flex min-w-0 flex-1 flex-col gap-1">
                            <div class="flex items-baseline gap-3">
                                <h1 class="min-w-0 flex-1 truncate text-xl font-semibold text-content">{{ title }}</h1>
                                <span v-if="percent !== undefined" class="shrink-0 font-mono text-lg tabular-nums text-muted" data-new-sandbox-percent>{{ percent }}%</span>
                            </div>
                            <p v-if="where" class="text-sm text-muted">{{ where }}</p>
                            <p v-if="phase === `failed`" class="flex items-center gap-1.5 text-sm font-medium text-danger" data-new-sandbox-failed>
                                <Icon name="exclamation-circle" aria-hidden="true" />{{ t(`home.newSandbox.failedLine`) }}
                            </p>
                            <p v-else-if="phase === `asking`" class="flex items-center gap-1.5 text-sm font-medium text-warning">
                                <Icon name="exclamation-circle" aria-hidden="true" />{{ t(`home.newSandbox.tile.asking`) }}
                            </p>
                            <p v-else-if="progressLine" class="text-sm text-content" data-new-sandbox-progress>{{ progressLine }}</p>
                        </div>
                    </header>

                    <!-- THE RUN: what the press started, then its first start; before it, the code being asked for, or why not. -->
                    <AddSandboxRun v-if="started" :here="run.here" :opening="run.opening.value" in-place @shown="run.opened" />
                    <Notice v-else-if="refusal" :of="refusal" />
                    <p v-else class="flex items-center gap-2 text-sm text-muted">
                        <Icon name="spinner" spin aria-hidden="true" />
                        {{ t(`home.newSandbox.preparing`) }}
                    </p>

                    <!-- The way on from a stop, under what the run said about it: again where that can help, or put away. -->
                    <div v-if="phase === `failed`" class="flex flex-wrap items-center gap-2">
                        <Button tier="accent" v-if="retried" :label="t(`ui.action.tryAgain`)" @click="run.retry" />
                        <Button :label="t(`home.newSandbox.dismiss`)" tier="quiet" @click="run.dismiss" />
                    </div>
                    <p v-else class="border-t border-line pt-4 text-xs text-muted">{{ t(`home.newSandbox.meanwhile`, { name: named }) }}</p>
                </div>
            </Page>
        </div>
    </section>
</template>
