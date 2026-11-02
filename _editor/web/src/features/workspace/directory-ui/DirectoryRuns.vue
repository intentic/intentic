<script setup lang="ts">
import { RUN_TARGETS_FILE } from "@intentic/sandbox-contract/schemas/run-targets";
import type { PanelStartSource } from "@intentic/sandbox-contract/schemas/panels";
import { Button, ui, Icon, Modal, toneDot } from "@intentic/ui";
import { computed, ref, watch } from "vue";
import { RouterLink, useRouter } from "vue-router";
import { useT } from "@intentic/ui/i18n";
import { errorMessage } from "@intentic/base/errors";
import { usePanels } from "../../../models/extensions/usePanels";
import { composeAgent } from "../../../models/fleet/agentActions";
import { useWorkspaceTabs } from "../../../models/workspace/tabs/useWorkspaceTabs";
import { openPreviewBeside } from "../../../workbench/browsers/browsersSurface";
import { stateOf, tintOf } from "../../preview/targetWords";
import { usePreviewTargets } from "../../preview/usePreviewTargets";
import { defaultPlace, type RunRow, runRowsOf, runsAt, SANDBOX } from "./runRows";
import { useDeviceRuns, useRunLog, useRunPresses, useRunTargets } from "../../../models/runs/useRunTargets";
import type { DeviceRun } from "@intentic/sandbox-contract/schemas/run-targets";

const t = useT();

/* RUN A REPOSITORY, in the sandbox or on one of your computers: one dialog for both. Where it runs is chosen once, above
   the list, the sandbox first and then every computer with whether it can take a run now; each target the repository's
   run-targets file declares (and, when that file says nothing for the sandbox, what Start finds in its own files) is
   then one row with one Run button. In the sandbox a run gets its own preview in Browsers, which opens on it; on a
   computer it opens the terminal it happens in, and the row then says what the computer reports of it (running, or
   how it ended) with its Stop, Restart, log and a Terminal that follows it again. */

const dir = defineModel<string | undefined>({ required: true });

const visible = computed({
    get: () => dir.value !== undefined,
    set: (open: boolean) => {
        if (!open) {
            dir.value = undefined;
        }
    },
});

const router = useRouter();
const { repos, devices } = useRunTargets();
const { pending, failure, run, stop: stopRun, stopping, reopen, follow } = useRunPresses();
const { allPanels } = usePanels();
const { targets: live, start: startLive, stop: stopLive } = usePreviewTargets(visible);
const { openFile } = useWorkspaceTabs();

const entry = computed(() => (repos.value ?? []).find((candidate) => candidate.repo === dir.value));
const panel = computed(() => allPanels.value.find((candidate) => candidate.repo === dir.value));
const rows = computed(() => (dir.value === undefined ? [] : runRowsOf(dir.value, entry.value, panel.value, live.value)));

type Device = (typeof devices.value)[number];

// Why a computer cannot take a run now, said under the picker when it is the chosen one; undefined when it can.
const blocked = (device: Device): string | undefined => {
    if (!device.online) {
        return t(`workspace.directoryRuns.offline`, { device: device.id });
    }
    if (!device.programs) {
        return t(`workspace.directoryRuns.agentTooOld`, { device: device.id });
    }
    return device.allowed ? undefined : t(`workspace.directoryRuns.switchOff`, { device: device.id });
};

// The dot beside a place's name: filled when it can take a run (the sandbox always can) or is connected but refusing
// until something is changed there, a hollow ring when asleep. Shape carries the difference as well as hue, since a
// skin's muted tones are close at 6px.
const DOT = `size-1.5 shrink-0 rounded-full`;
const dot = (device: Device): string =>
    !device.online ? `${DOT} border border-subtle` : toneDot(blocked(device) === undefined ? `success` : `warning`, DOT);

// By name, so a computer keeps its place in the row whichever is chosen.
const sorted = computed(() => devices.value.toSorted((a, b) => a.id.localeCompare(b.id)));
const ready = (id: string): boolean => {
    const device = sorted.value.find((candidate) => candidate.id === id);
    return device !== undefined && blocked(device) === undefined;
};

const picked = ref<string | undefined>(undefined);
// Opening another repository's runs starts from its own default, not the last one's choice.
watch(dir, () => {
    picked.value = undefined;
});
const place = computed(
    () =>
        picked.value ??
        defaultPlace(
            rows.value,
            sorted.value.map((device) => device.id),
            ready,
        ),
);
const inSandbox = computed(() => place.value === SANDBOX);
const chosen = computed(() => (inSandbox.value ? undefined : sorted.value.find((device) => device.id === place.value)));
const chosenBlocked = computed(() => (chosen.value === undefined ? undefined : blocked(chosen.value)));

// Where Start found the command, each said by its own literal key so the catalogs can see every one is used.
const foundWords = (found: PanelStartSource): string => {
    switch (found) {
        case `procfile`:
            return t(`workspace.directoryRuns.foundProcfile`);
        case `operator`:
            return t(`workspace.directoryRuns.foundOperator`);
        case `dev`:
            return t(`workspace.directoryRuns.foundDev`);
        case `start`:
            return t(`workspace.directoryRuns.foundStart`);
        case `cargo`:
            return t(`workspace.directoryRuns.foundCargo`);
    }
};
const descriptionOf = (row: RunRow): string | undefined => (row.found === undefined ? row.description : foundWords(row.found));

// Why a row cannot run where the dialog points, said in place of its button's effect.
const elsewhere = (row: RunRow): string =>
    inSandbox.value ? t(`workspace.directoryRuns.onComputersOnly`) : t(`workspace.directoryRuns.inSandboxOnly`);

/* ---- In the sandbox: start it, then show it where it is seen ---------------------------------------------------- */

const starting = ref<string | undefined>(undefined);
const sandboxFailure = ref<string | undefined>(undefined);
watch(dir, () => {
    sandboxFailure.value = undefined;
});

const show = (row: RunRow): void => {
    if (row.sandboxId === undefined) {
        return;
    }
    dir.value = undefined;
    openPreviewBeside(router, row.sandboxId);
};

const runInSandbox = async (row: RunRow): Promise<void> => {
    if (row.sandbox === undefined) {
        return;
    }
    starting.value = row.key;
    sandboxFailure.value = undefined;
    try {
        await startLive(row.sandbox);
        show(row);
    } catch (error) {
        sandboxFailure.value = t(`workspace.directoryRuns.couldntStart`, { target: row.name, reason: errorMessage(error) });
    } finally {
        starting.value = undefined;
    }
};

const stopInSandbox = async (row: RunRow): Promise<void> => {
    if (row.sandbox !== undefined) {
        await stopLive(row.sandbox);
    }
};

/* ---- On a computer ------------------------------------------------------------------------------------------- */

const isPending = (row: RunRow): boolean =>
    entry.value !== undefined && chosen.value !== undefined && pending(entry.value.repo, row.name, chosen.value.id);

// Run again while it runs is Restart: the daemon ends the last run's terminal, and the new run stops its program.
const runOnComputer = (row: RunRow): void => {
    if (entry.value !== undefined && chosen.value !== undefined) {
        run(entry.value.repo, row.name, chosen.value.id);
    }
};

// What the chosen computer runs: each row's newest run there, by the target's name.
const { runOf, terminalOf, listError } = useDeviceRuns(
    computed(() => chosen.value?.id),
    computed(() => visible.value && chosen.value !== undefined && chosenBlocked.value === undefined),
);
const deviceRun = (row: RunRow): DeviceRun | undefined => (inSandbox.value || !row.computers ? undefined : runOf(row.name));
const isRunning = (row: RunRow): boolean => deviceRun(row)?.state === `running`;

// The terminal the row's run is still in (building, pushing, or following its program), which a tab switch can have
// taken off the panel's strip.
const runTerminal = (row: RunRow): string | undefined =>
    inSandbox.value || entry.value === undefined || !row.computers ? undefined : terminalOf(entry.value.repo, row.name)?.session;
// Something of the row's to stop: its program running there, or its terminal still building it.
const isStoppable = (row: RunRow): boolean => isRunning(row) || runTerminal(row) !== undefined;

// A terminal to show: the run's own while it is open, else one that follows its program running there (the computer
// holds the program, as tmux holds a session: a terminal closed or left with Ctrl+D is only a view of it).
const hasTerminal = (row: RunRow): boolean => runTerminal(row) !== undefined || isRunning(row);
const openTerminal = (row: RunRow): void => {
    const session = runTerminal(row);
    const current = deviceRun(row);
    if (chosen.value === undefined || entry.value === undefined) {
        return;
    }
    if (session !== undefined) {
        reopen(session, row.name, chosen.value.id);
    } else if (current?.state === `running`) {
        follow(entry.value.repo, row.name, chosen.value.id, current.id);
    }
};

const isStopping = (row: RunRow): boolean =>
    entry.value !== undefined && chosen.value !== undefined && stopping(entry.value.repo, row.name, chosen.value.id);

const stopOnComputer = (row: RunRow): void => {
    if (entry.value !== undefined && chosen.value !== undefined) {
        stopRun(entry.value.repo, row.name, chosen.value.id, deviceRun(row)?.id);
    }
};

// A run's state beside its name, in words and a tone: running, perhaps running, or how it ended.
const stateWords = (row: RunRow): string => {
    const current = deviceRun(row);
    if (current?.state !== `running` && runTerminal(row) !== undefined) {
        return t(`workspace.directoryRuns.starting`);
    }
    if (current === undefined) {
        return ``;
    }
    if (current.state === `running`) {
        return t(`workspace.directoryRuns.running`);
    }
    return current.state === `unknown` ? t(`workspace.directoryRuns.mayBeRunning`) : current.said;
};
const stateTone = (row: RunRow): string => {
    const current = deviceRun(row);
    if (current?.state !== `running` && runTerminal(row) !== undefined) {
        return `text-warning`;
    }
    if (current?.state === `running`) {
        return `text-success`;
    }
    if (current?.state === `unknown`) {
        return `text-warning`;
    }
    return current?.exitCode !== undefined && current.exitCode !== 0 ? `text-danger` : `text-muted`;
};

// One log open at a time, the row's by its key; it follows that row's newest run.
const logRow = ref<string | undefined>(undefined);
watch([dir, place], () => {
    logRow.value = undefined;
});
const logRun = computed(() => {
    const row = rows.value.find((candidate) => candidate.key === logRow.value);
    return row === undefined ? undefined : deviceRun(row);
});
const { lines: logLines, failure: logFailure } = useRunLog(
    computed(() => chosen.value?.id),
    computed(() => logRun.value?.id),
    computed(() => visible.value && logRun.value !== undefined),
);
const toggleLog = (row: RunRow): void => {
    logRow.value = logRow.value === row.key ? undefined : row.key;
};

/* ---- Nothing to run yet ------------------------------------------------------------------------------------------ */

const editFile = (path: string): void => {
    dir.value = undefined;
    openFile(path);
};

const makeRunnable = (): void => {
    const repo = dir.value;
    if (repo !== undefined) {
        dir.value = undefined;
        composeAgent(t(`preview.previewPanel.makeStartablePrompt`, { repo }));
    }
};

const fileName = RUN_TARGETS_FILE.split(`/`).at(-1) ?? RUN_TARGETS_FILE;

const EXAMPLE = `{
  "targets": [
    { "name": "web", "command": "pnpm dev" },
    {
      "name": "app",
      "device": "my-pc",
      "build": "cargo xwin build --release --target x86_64-pc-windows-msvc",
      "artifact": "target/x86_64-pc-windows-msvc/release/app.exe"
    }
  ]
}`;

const PLACE = `touch-target flex cursor-pointer items-center gap-1.5 whitespace-nowrap rounded-md px-2.5 py-1 text-xs font-medium transition-colors`;
const placeClass = (id: string, online: boolean): string[] => [
    PLACE,
    id === place.value ? `ui-pill-on` : online ? `text-muted hover:text-content` : `text-subtle hover:text-content`,
];
</script>

<template>
    <Modal v-model:open="visible" size="md" :header="t(`workspace.directoryRuns.runIn`, { dir: dir ?? `` })">
        <template v-if="rows.length === 0 && entry?.error === undefined" #description>
            {{ t(`workspace.directoryRuns.declaresNothing`) }}
            <span class="font-mono text-content">{{ dir }}/{{ RUN_TARGETS_FILE }}</span>
        </template>

        <div class="flex flex-col gap-4">
            <template v-if="rows.length > 0 || entry?.error !== undefined">
                <!-- Where: one choice for every target below, the sandbox first, each computer with its state as a dot. -->
                <div class="flex flex-col gap-2">
                    <div class="flex flex-wrap items-center gap-x-3 gap-y-1.5">
                        <span id="directory-runs-where" class="text-xs text-subtle">{{ t(`workspace.directoryRuns.where`) }}</span>
                        <div role="radiogroup" aria-labelledby="directory-runs-where" class="flex flex-wrap items-center gap-1">
                            <button type="button" role="radio" :aria-checked="inSandbox" :class="placeClass(SANDBOX, true)" @click="picked = SANDBOX">
                                <span :class="toneDot(`success`, DOT)" aria-hidden="true" />
                                {{ t(`workspace.directoryRuns.sandbox`) }}
                            </button>
                            <button
                                v-for="device in sorted"
                                :key="device.id"
                                type="button"
                                role="radio"
                                :aria-checked="device.id === place"
                                :class="placeClass(device.id, device.online)"
                                @click="picked = device.id"
                            >
                                <span :class="dot(device)" aria-hidden="true" />
                                {{ device.id }}
                            </button>
                        </div>
                    </div>
                    <p
                        v-if="chosen !== undefined && chosenBlocked !== undefined"
                        class="text-xs"
                        :class="chosen.online ? `text-warning` : `text-muted`"
                    >
                        {{ chosenBlocked }}
                        <RouterLink v-if="chosen.online" :to="`/capabilities/${chosen.id}`" class="ml-1 text-link hover:underline">{{
                            t(`workspace.directoryRuns.openCard`)
                        }}</RouterLink>
                    </p>
                    <p v-else-if="!inSandbox && sorted.length === 0" class="text-xs text-muted">
                        {{ t(`workspace.directoryRuns.noComputers`) }}
                        <RouterLink to="/capabilities" class="ml-1 text-link hover:underline">{{
                            t(`workspace.directoryRuns.connectOne`)
                        }}</RouterLink>
                    </p>
                </div>

                <p v-if="entry?.error !== undefined" class="text-danger">{{ entry.error }}</p>

                <!-- What: the targets, flat on the dialog's own surface, one Run each where the place takes it. -->
                <ul class="flex flex-col divide-y divide-line-subtle border-t border-line-subtle">
                    <li v-for="row in rows" :key="row.key" class="flex flex-col gap-2 py-3">
                        <div class="flex items-center gap-4">
                            <div class="flex min-w-0 flex-1 flex-col gap-1" :class="runsAt(row, place) ? `` : `opacity-60`">
                                <div class="flex flex-wrap items-center gap-x-2.5 gap-y-0.5">
                                    <span class="font-mono text-sm text-content">{{ row.name }}</span>
                                    <span
                                        v-if="inSandbox && row.sandbox !== undefined && row.sandbox.running"
                                        class="inline-flex items-center gap-1 text-2xs"
                                        :class="tintOf(row.sandbox)"
                                    >
                                        <Icon name="circle" class="text-[0.5rem]" />{{ stateOf(row.sandbox) }}
                                    </span>
                                    <span v-if="stateWords(row) !== ``" class="inline-flex items-center gap-1 text-2xs" :class="stateTone(row)">
                                        <Icon name="circle" class="text-[0.5rem]" />{{ stateWords(row) }}
                                    </span>
                                    <span v-if="!inSandbox && row.isolated" class="inline-flex items-center gap-1 text-2xs text-subtle">
                                        <Icon name="shield" />{{ t(`workspace.directoryRuns.isolated`) }}
                                    </span>
                                </div>
                                <p v-if="descriptionOf(row) !== undefined" class="text-xs leading-relaxed text-muted">{{ descriptionOf(row) }}</p>
                                <p v-if="!runsAt(row, place)" class="text-2xs text-subtle">{{ elsewhere(row) }}</p>
                            </div>

                            <!-- In the sandbox: Run, or once it runs, Open and Stop. -->
                            <template v-if="inSandbox && runsAt(row, place)">
                                <div v-if="row.sandbox?.running === true" class="flex shrink-0 items-center gap-1.5">
                                    <Button :label="t(`ui.action.stop`)" tier="quiet" size="small" @click="stopInSandbox(row)" />
                                    <Button :label="t(`ui.action.open`)" tier="boring" size="small" @click="show(row)">
                                        <template #icon><Icon name="eye" class="mr-1.5 text-2xs" /></template>
                                    </Button>
                                </div>
                                <Button
                                    v-else
                                    class="shrink-0"
                                    :label="t(`workspace.directoryRuns.run`)"
                                    :aria-label="t(`workspace.directoryRuns.runInSandbox`, { target: row.name })"
                                    :title="t(`workspace.directoryRuns.runTipSandbox`)"
                                    tier="boring"
                                    size="small"
                                    :disabled="row.sandbox === undefined || starting !== undefined"
                                    :loading="starting === row.key || row.sandbox === undefined"
                                    @click="runInSandbox(row)"
                                >
                                    <template #icon><Icon name="play" class="mr-1.5 text-2xs" /></template>
                                </Button>
                            </template>
                            <!-- On a computer: Run, or once it runs there, Stop and Restart; its terminal while that is open, its log once it
                                 has run. -->
                            <div v-else class="flex shrink-0 items-center gap-1.5">
                                <Button
                                    v-if="hasTerminal(row) && chosen !== undefined"
                                    :label="t(`workspace.directoryRuns.terminal`)"
                                    :title="t(`workspace.directoryRuns.terminalTip`, { device: chosen.id })"
                                    tier="quiet"
                                    size="small"
                                    @click="openTerminal(row)"
                                >
                                    <template #icon><Icon name="terminal" class="mr-1.5 text-2xs" /></template>
                                </Button>
                                <Button
                                    v-if="deviceRun(row) !== undefined"
                                    :label="logRow === row.key ? t(`workspace.directoryRuns.hideLog`) : t(`workspace.directoryRuns.log`)"
                                    :aria-expanded="logRow === row.key"
                                    tier="quiet"
                                    size="small"
                                    @click="toggleLog(row)"
                                />
                                <Button
                                    v-if="isStoppable(row) && chosen !== undefined"
                                    :label="t(`ui.action.stop`)"
                                    :aria-label="t(`workspace.directoryRuns.stopOn`, { target: row.name, device: chosen.id })"
                                    :title="t(`workspace.directoryRuns.stopTip`, { device: chosen.id })"
                                    tier="quiet"
                                    size="small"
                                    :disabled="chosenBlocked !== undefined"
                                    :loading="isStopping(row)"
                                    @click="stopOnComputer(row)"
                                >
                                    <template #icon><Icon name="stop" class="mr-1.5 text-2xs" /></template>
                                </Button>
                                <Button
                                    :label="isRunning(row) ? t(`workspace.directoryRuns.restart`) : t(`workspace.directoryRuns.run`)"
                                    :aria-label="
                                        chosen === undefined
                                            ? undefined
                                            : isRunning(row)
                                              ? t(`workspace.directoryRuns.restartOn`, { target: row.name, device: chosen.id })
                                              : t(`workspace.directoryRuns.runOn`, { target: row.name, device: chosen.id })
                                    "
                                    :title="
                                        chosen === undefined
                                            ? undefined
                                            : isRunning(row)
                                              ? t(`workspace.directoryRuns.restartTip`, { device: chosen.id })
                                              : t(`workspace.directoryRuns.runTip`, { device: chosen.id })
                                    "
                                    tier="boring"
                                    size="small"
                                    :disabled="!runsAt(row, place) || chosen === undefined || chosenBlocked !== undefined || isStopping(row)"
                                    :loading="isPending(row)"
                                    @click="runOnComputer(row)"
                                >
                                    <template #icon><Icon :name="isRunning(row) ? `refresh` : `play`" class="mr-1.5 text-2xs" /></template>
                                </Button>
                            </div>
                        </div>
                        <!-- The run's log on the computer, followed while it is open. -->
                        <div v-if="logRow === row.key && deviceRun(row) !== undefined" class="flex flex-col gap-1">
                            <pre
                                class="max-h-60 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-canvas px-3 py-2 font-mono text-2xs text-content"
                                aria-live="polite"
                                >{{ logLines.length === 0 ? t(`workspace.directoryRuns.logEmpty`) : logLines.join(`\n`) }}</pre>
                            <p v-if="logFailure !== undefined" class="text-2xs text-danger">{{ logFailure }}</p>
                        </div>
                    </li>
                </ul>
                <p v-if="!inSandbox && chosen !== undefined && listError !== undefined" class="text-xs text-warning">
                    {{ t(`workspace.directoryRuns.listFailed`, { device: chosen.id, reason: listError }) }}
                </p>
                <p v-if="inSandbox && sandboxFailure !== undefined" class="text-xs text-danger">{{ sandboxFailure }}</p>
                <p v-else-if="!inSandbox && failure !== undefined" class="text-xs text-danger">{{ failure }}</p>
            </template>

            <!-- Nothing says how to run it: an agent can work that out, or the file can be written by hand. -->
            <template v-else>
                <div>
                    <Button tier="accent" :label="t(`preview.previewPanel.makeStartable`)" size="small" @click="makeRunnable">
                        <template #icon><Icon name="sparkles" /></template>
                    </Button>
                </div>
                <pre class="overflow-x-auto rounded-lg bg-canvas px-3 py-2 font-mono text-2xs text-content">{{ EXAMPLE }}</pre>
            </template>
        </div>

        <template #footer>
            <!-- The file is the source of truth and lives in the repository; the switches a run needs live on the cards. -->
            <button
                v-if="entry !== undefined"
                type="button"
                :class="ui.textButton({ tone: `quiet` })"
                :title="entry.path"
                @click="editFile(entry.path)"
            >
                <Icon name="file-edit" class="text-2xs" />{{ t(`workspace.directoryRuns.editFile`, { file: fileName }) }}
            </button>
            <RouterLink to="/capabilities" :class="ui.textButton({ tone: `quiet` }, `mr-auto`)">
                {{ t(`workspace.directoryRuns.yourComputers`) }} <Icon name="arrow-right" class="text-2xs" />
            </RouterLink>
            <Button :label="t(`ui.action.close`)" tier="quiet" @click="dir = undefined" />
        </template>
    </Modal>
</template>
