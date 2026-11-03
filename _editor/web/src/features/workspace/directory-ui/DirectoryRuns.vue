<script setup lang="ts">
import { RUN_TARGETS_FILE } from "@intentic/sandbox-contract/schemas/run-targets";
import type { PanelStartSource } from "@intentic/sandbox-contract/schemas/panels";
import { Button, DisclosureRow, Icon, Modal, Notice, RowGroup, toneDot, ui } from "@intentic/ui";
import { computed, ref, watch } from "vue";
import { RouterLink, useRouter } from "vue-router";
import { useT } from "@intentic/ui/i18n";
import { formatDateTime } from "@intentic/ui/format";
import { errorMessage } from "@intentic/base/errors";
import { usePanels } from "../../../models/extensions/usePanels";
import { composeAgent } from "../../../models/fleet/agentActions";
import { useWorkspaceTabs } from "../../../models/workspace/tabs/useWorkspaceTabs";
import { openPreviewBeside } from "../../../workbench/browsers/browsersSurface";
import { stateOf, tintOf } from "../../preview/targetWords";
import { usePreviewTargets } from "../../preview/usePreviewTargets";
import { openingPlace, placesOf, provenanceOf, type RunRow, runRowsOf, runsAt, SANDBOX } from "./runRows";
import { rememberedPlace, rememberPlace } from "./runPlaceMemory";
import { useDeviceRuns, useRunLog, useRunPresses, useRunTargets } from "../../../models/runs/useRunTargets";
import type { DeviceRun } from "@intentic/sandbox-contract/schemas/run-targets";

const t = useT();

/* RUN A REPOSITORY, in the sandbox or on one of your computers: one dialog for both. Where it runs is chosen once, under
   the title, the sandbox first and then every computer with whether it can take a run now and how many targets run
   there; the pick is remembered per repository (runPlaceMemory.ts), so the dialog opens where it was last run from.
   The list under it holds only what runs in that place, each target the repository's run-targets file declares (and,
   when that file says nothing for the sandbox, what Start finds in its own files) as one row: its name and state, its
   description on one line, and Run. A row opens on press into the whole description, what it runs and, on a computer,
   the log of its newest run there. In the sandbox a run gets its own preview in Browsers, which opens on it; on a
   computer it opens the terminal it happens in, and the row then says what the computer reports of it (running, or
   how it ended) with its Stop, Restart and a Terminal that follows it again. */

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

const deviceIds = computed(() => sorted.value.map((device) => device.id));
// The places with something to run, each with how many targets run there: every computer counts the same rows.
const places = computed(() => placesOf(rows.value, deviceIds.value));
const countAt = (id: string): number => rows.value.filter((row) => runsAt(row, id)).length;

// The reader's pick, read back for each repository the dialog opens on; a place no longer offered is passed over.
const picked = ref<string | undefined>(undefined);
// THE LIST'S FLOOR while the dialog stays open: switching to a place with fewer targets keeps the height the list had,
// since the dialog is centred and shrinking it would move the "where" row out from under the pointer. It opens at its
// content's own height, so a short list is never padded with room it never had.
const list = ref<HTMLElement>();
const floor = ref(0);
watch(
    dir,
    (repo) => {
        picked.value = repo === undefined ? undefined : rememberedPlace(repo);
        floor.value = 0;
    },
    { immediate: true },
);
const pick = (id: string): void => {
    floor.value = Math.max(floor.value, list.value?.offsetHeight ?? 0);
    picked.value = id;
    if (dir.value !== undefined) {
        rememberPlace(dir.value, id);
    }
};
const place = computed(() => openingPlace(rows.value, deviceIds.value, ready, picked.value));
// What the list holds: the rows that run where the dialog points, in the file's order.
const shown = computed(() => rows.value.filter((row) => runsAt(row, place.value)));
// Rows that run only on a computer while none is connected: no place offers them, so the list says they exist.
const unplaced = computed(() => (sorted.value.length === 0 ? rows.value.filter((row) => row.computers && row.sandboxId === undefined).length : 0));
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

// What the row's run on the computer was built from, and the work that landed after it (schemas/run-targets.ts
// RunBuiltFromSchema): so the owner can tell whether what runs there is the newest, or a Restart would bring more.
const builtFromOf = (row: RunRow): { line: string; tip: string; stale: boolean } | undefined => {
    const built = provenanceOf(deviceRun(row));
    if (built === undefined || chosen.value === undefined) {
        return undefined;
    }
    const { commit, changed, lands } = built;
    const line = [t(`workspace.directoryRuns.builtFrom`, { commit }), ...(lands > 0 ? [t(`workspace.directoryRuns.landsSince`, { count: lands }, lands)] : [])].join(` · `);
    const tip = [
        t(`workspace.directoryRuns.builtFromTip`, { device: chosen.value.id, commit, changed, at: formatDateTime(built.at) }),
        ...(lands > 0 ? [t(`workspace.directoryRuns.landsSinceTip`)] : []),
        ...(built.moved ? [t(`workspace.directoryRuns.movedDuringBuild`)] : []),
    ].join(` `);
    return { line, tip, stale: built.stale };
};

// One row open at a time, by its key: its whole description, what it runs here, and on a computer the log of its newest
// run there, followed while it is open.
const openRow = ref<string | undefined>(undefined);
watch([dir, place], () => {
    openRow.value = undefined;
});
const setOpen = (row: RunRow, open: boolean): void => {
    openRow.value = open ? row.key : undefined;
};
const isOpen = (row: RunRow): boolean => openRow.value === row.key;
// What the open row says it runs in the chosen place: the sandbox's command, or the build made here for a computer.
const commandHere = (row: RunRow): string | undefined => (inSandbox.value ? row.command : row.build);
// A row opens only onto something its line does not already say.
const opens = (row: RunRow): boolean =>
    (row.found === undefined && row.description !== undefined) || commandHere(row) !== undefined || deviceRun(row) !== undefined;
const logRun = computed(() => {
    const row = rows.value.find((candidate) => candidate.key === openRow.value);
    return row === undefined ? undefined : deviceRun(row);
});
const { lines: logLines, failure: logFailure } = useRunLog(
    computed(() => chosen.value?.id),
    computed(() => logRun.value?.id),
    computed(() => visible.value && logRun.value !== undefined),
);

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
// A run's state beside a name: a small ring of its tone, then its words.
const STATE = `inline-flex shrink-0 items-center gap-1 text-2xs font-normal`;
const placeClass = (id: string, online: boolean): string[] => [
    PLACE,
    id === place.value ? `ui-pill-on` : online ? `text-muted hover:text-content` : `text-subtle hover:text-content`,
];
</script>

<template>
    <Modal v-model:open="visible" size="md">
        <template #header="{ titleClass, titleId }">
            <span :id="titleId" :class="titleClass">{{ t(`workspace.directoryRuns.runIn`, { dir: dir ?? `` }) }}</span>
            <!-- Where: one choice for every target below, under the title so it stays put while a long list scrolls. The
                 sandbox first, then each computer with its state as a dot; each with how many targets run there. -->
            <div v-if="places.length > 1 || (places.length === 1 && !inSandbox)" class="mt-2 flex flex-wrap items-center gap-x-3 gap-y-1.5">
                <span id="directory-runs-where" class="text-xs font-normal text-subtle">{{ t(`workspace.directoryRuns.where`) }}</span>
                <div role="radiogroup" aria-labelledby="directory-runs-where" class="flex flex-wrap items-center gap-1">
                    <button
                        v-if="places.includes(SANDBOX)"
                        type="button"
                        role="radio"
                        :aria-checked="inSandbox"
                        :class="placeClass(SANDBOX, true)"
                        @click="pick(SANDBOX)"
                    >
                        <span :class="toneDot(`success`, DOT)" aria-hidden="true" />
                        {{ t(`workspace.directoryRuns.sandbox`) }}
                        <span class="tabular-nums text-subtle">{{ countAt(SANDBOX) }}</span>
                    </button>
                    <template v-if="places.length > (places.includes(SANDBOX) ? 1 : 0)">
                        <button
                            v-for="device in sorted"
                            :key="device.id"
                            type="button"
                            role="radio"
                            :aria-checked="device.id === place"
                            :class="placeClass(device.id, device.online)"
                            @click="pick(device.id)"
                        >
                            <span :class="dot(device)" aria-hidden="true" />
                            {{ device.id }}
                            <span class="tabular-nums text-subtle">{{ countAt(device.id) }}</span>
                        </button>
                    </template>
                </div>
            </div>
        </template>
        <template v-if="rows.length === 0 && entry?.error === undefined" #description>
            {{ t(`workspace.directoryRuns.declaresNothing`) }}
            <span class="font-mono text-content">{{ dir }}/{{ RUN_TARGETS_FILE }}</span>
        </template>

        <div class="flex flex-col gap-3">
            <template v-if="rows.length > 0 || entry?.error !== undefined">
                <!-- What went wrong, first: below a long list it would never be seen. -->
                <Notice v-if="entry?.error !== undefined" tone="danger" size="sm">{{ entry.error }}</Notice>
                <Notice v-if="chosen !== undefined && chosenBlocked !== undefined" :tone="chosen.online ? `warning` : `info`" size="sm">
                    {{ chosenBlocked }}
                    <template v-if="chosen.online" #actions>
                        <RouterLink :to="`/capabilities/${chosen.id}`" :class="ui.textButton()">{{
                            t(`workspace.directoryRuns.openCard`)
                        }}</RouterLink>
                    </template>
                </Notice>
                <Notice v-if="!inSandbox && chosen !== undefined && listError !== undefined" tone="warning" size="sm">
                    {{ t(`workspace.directoryRuns.listFailed`, { device: chosen.id, reason: listError }) }}
                </Notice>
                <Notice v-if="inSandbox && sandboxFailure !== undefined" tone="danger" size="sm">{{ sandboxFailure }}</Notice>
                <Notice v-else-if="!inSandbox && failure !== undefined" tone="danger" size="sm">{{ failure }}</Notice>

                <!-- What: only the targets that run where the dialog points, flat on the dialog's own surface, each its name, its
                     state and one line of what it does, opening into the rest. -->
                <div ref="list" class="flex flex-col gap-3" :style="floor > 0 ? { minHeight: `${floor}px` } : undefined">
                    <RowGroup v-if="shown.length > 0">
                        <DisclosureRow
                            v-for="row in shown"
                            :key="row.key"
                            :open="isOpen(row)"
                            :disabled="!opens(row)"
                            @update:open="setOpen(row, $event)"
                        >
                            <template #title>
                                <span class="flex min-w-0 items-center gap-2.5">
                                    <span class="min-w-0 truncate font-mono">{{ row.name }}</span>
                                    <span v-if="inSandbox && row.sandbox !== undefined && row.sandbox.running" :class="[STATE, tintOf(row.sandbox)]">
                                        <Icon name="circle" class="text-[0.5rem]" />{{ stateOf(row.sandbox) }}
                                    </span>
                                    <span v-if="stateWords(row) !== ``" :class="[STATE, stateTone(row)]">
                                        <Icon name="circle" class="text-[0.5rem]" />{{ stateWords(row) }}
                                    </span>
                                    <span
                                        v-if="builtFromOf(row) !== undefined"
                                        v-tooltip="builtFromOf(row)?.tip"
                                        :class="[STATE, builtFromOf(row)?.stale === true ? `text-warning` : `text-subtle`]"
                                    >
                                        <Icon name="git-branch" />{{ builtFromOf(row)?.line }}
                                    </span>
                                    <span v-if="!inSandbox && row.isolated" :class="[STATE, `text-subtle`]">
                                        <Icon name="shield" />{{ t(`workspace.directoryRuns.isolated`) }}
                                    </span>
                                </span>
                            </template>
                            <!-- One line while closed (two on a phone); the whole of it once the row is open. -->
                            <template v-if="descriptionOf(row) !== undefined" #description>
                                <span :class="isOpen(row) ? `` : `line-clamp-2 md:line-clamp-1`">{{ descriptionOf(row) }}</span>
                            </template>

                            <template #control>
                                <!-- In the sandbox: Run, or once it runs, Stop and Open. -->
                                <template v-if="inSandbox">
                                    <template v-if="row.sandbox?.running === true">
                                        <Button :label="t(`ui.action.stop`)" tier="quiet" size="small" @click="stopInSandbox(row)" />
                                        <Button :label="t(`ui.action.open`)" tier="boring" size="small" @click="show(row)">
                                            <template #icon><Icon name="eye" class="mr-1.5 text-2xs" /></template>
                                        </Button>
                                    </template>
                                    <!-- Repeated down the list, so quiet: a column of boxes would outshout the names. -->
                                    <Button
                                        v-else
                                        :label="t(`workspace.directoryRuns.run`)"
                                        :aria-label="t(`workspace.directoryRuns.runInSandbox`, { target: row.name })"
                                        :title="t(`workspace.directoryRuns.runTipSandbox`)"
                                        tier="quiet"
                                        size="small"
                                        :disabled="row.sandbox === undefined || starting !== undefined"
                                        :loading="starting === row.key || row.sandbox === undefined"
                                        @click="runInSandbox(row)"
                                    >
                                        <template #icon><Icon name="play" class="mr-1.5 text-2xs" /></template>
                                    </Button>
                                </template>
                                <!-- On a computer: Run, or once it runs there, Stop and Restart; the terminal it runs in, while there is one. -->
                                <template v-else>
                                    <button
                                        v-if="hasTerminal(row) && chosen !== undefined"
                                        v-tooltip="t(`workspace.directoryRuns.terminal`)"
                                        type="button"
                                        :class="ui.iconButton()"
                                        :aria-label="t(`workspace.directoryRuns.terminalTip`, { device: chosen.id })"
                                        @click="openTerminal(row)"
                                    >
                                        <Icon name="terminal" class="text-xs" />
                                    </button>
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
                                        tier="quiet"
                                        size="small"
                                        :disabled="chosen === undefined || chosenBlocked !== undefined || isStopping(row)"
                                        :loading="isPending(row)"
                                        @click="runOnComputer(row)"
                                    >
                                        <template #icon><Icon :name="isRunning(row) ? `refresh` : `play`" class="mr-1.5 text-2xs" /></template>
                                    </Button>
                                </template>
                            </template>

                            <!-- Open: what it runs here, then on a computer the log of its newest run there, followed while open. -->
                            <template #below>
                                <div class="flex flex-col gap-2.5 pb-1">
                                    <div v-if="commandHere(row) !== undefined" class="flex flex-col gap-1">
                                        <span class="text-2xs text-subtle">{{
                                            inSandbox ? t(`workspace.directoryRuns.runsCommand`) : t(`workspace.directoryRuns.buildsCommand`)
                                        }}</span>
                                        <code class="whitespace-pre-wrap break-all font-mono text-2xs text-content">{{ commandHere(row) }}</code>
                                    </div>
                                    <div v-if="deviceRun(row) !== undefined" class="flex flex-col gap-1">
                                        <span class="text-2xs text-subtle">{{ t(`workspace.directoryRuns.log`) }}</span>
                                        <pre
                                            class="max-h-60 overflow-auto whitespace-pre-wrap break-all rounded-lg bg-canvas px-3 py-2 font-mono text-2xs text-content"
                                            aria-live="polite"
                                            >{{ logLines.length === 0 ? t(`workspace.directoryRuns.logEmpty`) : logLines.join(`\n`) }}</pre>
                                        <p v-if="logFailure !== undefined" class="text-2xs text-danger">{{ logFailure }}</p>
                                    </div>
                                </div>
                            </template>
                        </DisclosureRow>
                    </RowGroup>
                    <!-- Targets only a computer runs, while none is connected: no place to pick them from, so they are named here. -->
                    <p v-if="unplaced > 0" class="text-xs text-muted">
                        {{ t(`workspace.directoryRuns.noComputerFor`, { count: unplaced }, unplaced) }}
                        <RouterLink to="/capabilities" class="ml-1 text-link hover:underline">{{
                            t(`workspace.directoryRuns.connectOne`)
                        }}</RouterLink>
                    </p>
                </div>
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
