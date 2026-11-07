<!-- One program on a Run lane: running, starting, fallen over, or ready to start there. Its name and state, one line of
     how it runs (or what it is), and its presses; open, what it runs and, on a computer, the log of its run there. -->
<script setup lang="ts">
import type { PanelStartSource } from "@intentic/sandbox-contract/schemas/panels";
import { Button, DisclosureRow, Icon, ui } from "@intentic/ui";
import { formatDateTime, timeAgo } from "@intentic/ui/format";
import { useT } from "@intentic/ui/i18n";
import { computed, inject } from "vue";
import type { AgentFix } from "../../models/fixes/agentFix";
import { computerRunFix } from "../../models/runs/runFixes";
import FixWithAgent from "../../parts/fleet/FixWithAgent.vue";
import { stateOf } from "../preview/targetWords";
import { RUN_ACTIONS } from "./runActions";
import type { RunBlock, RunItem } from "./runLanes";
import { provenanceOf, SANDBOX } from "./runRows";

const t = useT();

const { place, block, item, showRepo } = defineProps<{
    /** The lane's place: SANDBOX or the computer's id. */
    place: string;
    /** Why the lane's computer cannot take a run now; its rows keep their Stop. */
    block: RunBlock | undefined;
    item: RunItem;
    /** Under "All repositories" a name alone does not say whose it is. */
    showRepo: boolean;
}>();

const actions = inject(RUN_ACTIONS)!;

const inSandbox = computed(() => place === SANDBOX);
const row = computed(() => item.row);
const run = computed(() => item.run);
const name = computed(() => row.value?.name ?? run.value?.name ?? item.key);
// A program no run.json names is stopped and read by its run id; the daemon asks for a repository and a target to close a
// terminal of its own by, which such a program never had, so the workspace root stands in.
const repo = computed(() => item.repo ?? `root`);
const target = computed(() => row.value?.name ?? run.value?.name ?? ``);

// Where Start found the command, each said by its own literal key so the catalogs can see every one is used.
const foundWords = (found: PanelStartSource): string => {
    switch (found) {
        case `procfile`:
            return t(`run.view.foundProcfile`);
        case `operator`:
            return t(`run.view.foundOperator`);
        case `dev`:
            return t(`run.view.foundDev`);
        case `start`:
            return t(`run.view.foundStart`);
        case `cargo`:
            return t(`run.view.foundCargo`);
    }
};
const about = computed(() => {
    if (row.value === undefined) {
        return t(`run.view.notDeclared`);
    }
    return row.value.found === undefined ? row.value.description : foundWords(row.value.found);
});

// How it runs there, in one line: since when, who started it, which of the computer's ports the sandbox reaches for it.
const facts = computed(() => {
    const current = run.value;
    if (inSandbox.value || current === undefined || item.state === `idle` || item.state === `starting`) {
        return undefined;
    }
    const ended = current.state === `ended` && current.endedAt !== undefined;
    const parts = [
        ended ? t(`run.view.endedAgo`, { ago: timeAgo(Date.parse(current.endedAt!)) }) : t(`run.view.startedAgo`, { ago: timeAgo(Date.parse(current.startedAt)) }),
        ...(current.startedBy === undefined ? [] : [t(`run.view.startedBy`, { who: current.startedBy })]),
        ...(current.ports.length === 0 || ended
            ? []
            : [t(`run.view.reaches`, { ports: current.ports.map((port) => `:${port}`).join(` `) }, current.ports.length)]),
    ];
    return parts.join(` · `);
});
// The line under the name: how it runs while it does, what it is otherwise.
const line = computed(() => facts.value ?? about.value);

// Its state beside its name, in words and a tone.
const state = computed((): { words: string; tone: string } | undefined => {
    if (item.state === `running`) {
        return { words: inSandbox.value && row.value?.sandbox !== undefined ? stateOf(row.value.sandbox) : t(`run.view.running`), tone: `text-success` };
    }
    if (item.state === `starting`) {
        return { words: t(`run.view.starting`), tone: inSandbox.value ? `text-info` : `text-warning` };
    }
    if (item.state === `unknown`) {
        return { words: t(`run.view.mayBeRunning`), tone: `text-warning` };
    }
    return item.state === `failed` ? { words: run.value?.said ?? ``, tone: `text-danger` } : undefined;
});

// What its run on the computer was built from, and the work that landed after it: whether a Restart would bring more.
const built = computed(() => {
    const provenance = provenanceOf(run.value);
    if (provenance === undefined || inSandbox.value || item.state === `idle`) {
        return undefined;
    }
    const { commit, changed, lands } = provenance;
    const words = [t(`run.view.builtFrom`, { commit }), ...(lands > 0 ? [t(`run.view.landsSince`, { count: lands }, lands)] : [])].join(` · `);
    const tip = [
        t(`run.view.builtFromTip`, { device: place, commit, changed, at: formatDateTime(provenance.at) }),
        ...(lands > 0 ? [t(`run.view.landsSinceTip`)] : []),
        ...(provenance.moved ? [t(`run.view.movedDuringBuild`)] : []),
    ].join(` `);
    return { words, tip, stale: provenance.stale };
});

/* ---- Presses ------------------------------------------------------------------------------------------------- */

const up = computed(() => item.state === `running` || item.state === `unknown`);
// Run pressed again while its build still goes is a restart too: the daemon ends that terminal and starts anew.
const again = computed(() => up.value || item.state === `starting`);
const sandboxBusy = computed(() => actions.starting.value !== undefined);
const pending = computed(() => item.repo !== undefined && actions.pending(item.repo, target.value, place));
const stopping = computed(() => actions.stopping(repo.value, target.value, place));
// Something of it to stop on the computer: its program, or its terminal still building it.
const stoppable = computed(() => up.value || item.terminal !== undefined);
// Run again while it runs is Restart: the daemon ends the last run's terminal, and the new run stops its program.
const canRun = computed(() => row.value?.computers === true && item.repo !== undefined);
const hasTerminal = computed(() => item.terminal !== undefined || (run.value?.state === `running` && item.repo !== undefined));

const runOnComputer = (): void => {
    if (item.repo !== undefined) {
        actions.run(item.repo, target.value, place);
    }
};
const stopOnComputer = (): void => actions.stop(repo.value, target.value, place, run.value?.id);
const openTerminal = (): void => {
    if (item.terminal !== undefined) {
        actions.reopen(item.terminal.session, target.value, place);
    } else if (run.value !== undefined && item.repo !== undefined) {
        actions.follow(item.repo, target.value, place, run.value.id);
    }
};

/* ---- Open ---------------------------------------------------------------------------------------------------- */

const open = computed(() => actions.isOpen(place, item));
// What it runs in this place: the sandbox's command, or the build made here for a computer.
const command = computed(() => (inSandbox.value ? row.value?.command : row.value?.build));
const logged = computed(() => !inSandbox.value && run.value !== undefined);
// The whole description, when the closed line said how it runs instead.
const fullAbout = computed(() => (facts.value === undefined ? undefined : about.value));
const opens = computed(() => fullAbout.value !== undefined || command.value !== undefined || logged.value || (about.value?.length ?? 0) > 80);
const lines = computed(() => (open.value && actions.logRun.value === run.value?.id ? actions.log.lines.value : []));

// A run that ended in failure, with the log the row is following for it: what an agent reads first.
const failedFix = computed((): AgentFix | undefined => {
    const ended = run.value;
    if (item.state !== `failed` || ended?.exitCode === undefined || item.repo === undefined || lines.value.length === 0) {
        return undefined;
    }
    return computerRunFix({
        repo: item.repo,
        target: target.value,
        device: place,
        exitCode: ended.exitCode,
        command: command.value,
        log: lines.value.join(`\n`),
        title: `${target.value}: ${ended.said}`,
    });
});

// A state beside a name: a small ring of its tone, then its words.
const STATE = `inline-flex shrink-0 items-center gap-1 text-2xs font-normal`;
</script>

<template>
    <DisclosureRow :open="open" :disabled="!opens" @update:open="actions.setOpen(place, item, $event)">
        <template #title>
            <span class="flex min-w-0 items-center gap-2.5">
                <span class="min-w-0 truncate font-mono">
                    <span v-if="showRepo && item.repo !== undefined" class="text-subtle">{{ item.repo }} / </span>{{ name }}
                </span>
                <span v-if="state !== undefined" :class="[STATE, state.tone]"><Icon name="circle" class="text-[0.5rem]" />{{ state.words }}</span>
                <span v-if="built !== undefined" v-tooltip="built.tip" :class="[STATE, built.stale ? `text-warning` : `text-subtle`]">
                    <Icon name="git-branch" />{{ built.words }}
                </span>
                <span v-if="!inSandbox && row?.isolated" :class="[STATE, `text-subtle`]"><Icon name="shield" />{{ t(`run.view.isolated`) }}</span>
            </span>
        </template>
        <template v-if="line !== undefined" #description>
            <span :class="open ? `` : `line-clamp-2 md:line-clamp-1`">{{ line }}</span>
        </template>

        <template #control>
            <!-- In the sandbox: Run, or once it runs, Stop and Open. -->
            <template v-if="inSandbox && row !== undefined">
                <template v-if="item.state !== `idle`">
                    <Button :label="t(`ui.action.stop`)" tier="quiet" size="small" @click="actions.stopInSandbox(row)" />
                    <Button :label="t(`ui.action.open`)" tier="boring" size="small" @click="actions.show(row)">
                        <template #icon><Icon name="eye" class="mr-1.5 text-2xs" /></template>
                    </Button>
                </template>
                <!-- Repeated down the list, so quiet: a column of boxes would outshout the names. -->
                <Button
                    v-else
                    :label="t(`run.view.run`)"
                    :aria-label="t(`run.view.runInSandbox`, { target: name })"
                    :title="t(`run.view.runTipSandbox`)"
                    tier="quiet"
                    size="small"
                    :disabled="row.sandbox === undefined || sandboxBusy"
                    :loading="actions.starting.value === item.key || row.sandbox === undefined"
                    @click="actions.runInSandbox(item.repo!, item)"
                >
                    <template #icon><Icon name="play" class="mr-1.5 text-2xs" /></template>
                </Button>
            </template>
            <!-- On a computer: Run, or once it runs there, Stop and Restart; the terminal it runs in, while there is one. -->
            <template v-else-if="!inSandbox">
                <button
                    v-if="hasTerminal"
                    v-tooltip="t(`run.view.terminal`)"
                    type="button"
                    :class="ui.iconButton()"
                    :aria-label="t(`run.view.terminalTip`, { device: place })"
                    :disabled="block !== undefined"
                    @click="openTerminal"
                >
                    <Icon name="terminal" class="text-xs" />
                </button>
                <Button
                    v-if="stoppable"
                    :label="t(`ui.action.stop`)"
                    :aria-label="t(`run.view.stopOn`, { target: name, device: place })"
                    :title="t(`run.view.stopTip`, { device: place })"
                    tier="quiet"
                    size="small"
                    :disabled="block !== undefined"
                    :loading="stopping"
                    @click="stopOnComputer"
                >
                    <template #icon><Icon name="stop" class="mr-1.5 text-2xs" /></template>
                </Button>
                <!-- A run built before work landed is the one row asking for a press: its Restart is the fix, so it lights. -->
                <Button
                    v-if="canRun"
                    :label="again ? t(`run.view.restart`) : t(`run.view.run`)"
                    :aria-label="again ? t(`run.view.restartOn`, { target: name, device: place }) : t(`run.view.runOn`, { target: name, device: place })"
                    :title="again ? t(`run.view.restartTip`, { device: place }) : t(`run.view.runTip`, { device: place })"
                    :tier="up && built?.stale === true ? `accent` : `quiet`"
                    size="small"
                    :disabled="block !== undefined || stopping"
                    :loading="pending"
                    @click="runOnComputer"
                >
                    <template #icon><Icon :name="again ? `refresh` : `play`" class="mr-1.5 text-2xs" /></template>
                </Button>
            </template>
        </template>

        <!-- Open: the whole description, what it runs here, then on a computer the log of its run there, followed while open. -->
        <template #below>
            <div class="flex flex-col gap-2.5 pb-1">
                <p v-if="fullAbout !== undefined" class="text-xs text-muted">{{ fullAbout }}</p>
                <div v-if="command !== undefined" class="flex flex-col gap-1">
                    <span class="text-2xs text-subtle">{{ inSandbox ? t(`run.view.runsCommand`) : t(`run.view.buildsCommand`) }}</span>
                    <code class="whitespace-pre-wrap break-all font-mono text-2xs text-content">{{ command }}</code>
                </div>
                <div v-if="logged" class="flex flex-col gap-1">
                    <span class="text-2xs text-subtle">{{ t(`run.view.log`) }}</span>
                    <pre
                        class="max-h-60 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-canvas px-3 py-2 font-mono text-2xs text-content"
                        aria-live="polite"
                        >{{ lines.length === 0 ? t(`run.view.logEmpty`) : lines.join(`\n`) }}</pre
                    >
                    <p v-if="actions.log.failure.value !== undefined" class="text-2xs text-danger">{{ actions.log.failure.value }}</p>
                    <div v-if="failedFix" class="flex justify-end"><FixWithAgent :fix="failedFix" /></div>
                </div>
            </div>
        </template>
    </DisclosureRow>
</template>
