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
import { useRunPresses, useRunTargets } from "../../../models/runs/useRunTargets";

const t = useT();

/* RUN A REPOSITORY, in the sandbox or on one of your computers: one dialog for both. Where it runs is chosen once, above
   the list, the sandbox first and then every computer with whether it can take a run now; each target the repository's
   run-targets file declares (and, when that file says nothing for the sandbox, what Start finds in its own files) is
   then one row with one Run button. In the sandbox a run gets its own preview in Browsers, which opens on it; on a
   computer it opens the terminal it happens in. */

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
const { pending, failure, run } = useRunPresses();
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

const runOnComputer = (row: RunRow): void => {
    if (entry.value !== undefined && chosen.value !== undefined) {
        run(entry.value.repo, row.name, chosen.value.id);
    }
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
                            <button
                                type="button"
                                role="radio"
                                :aria-checked="inSandbox"
                                :class="placeClass(SANDBOX, true)"
                                @click="picked = SANDBOX"
                            >
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
                    <p v-if="chosen !== undefined && chosenBlocked !== undefined" class="text-xs" :class="chosen.online ? `text-warning` : `text-muted`">
                        {{ chosenBlocked }}
                        <RouterLink v-if="chosen.online" :to="`/capabilities/${chosen.id}`" class="ml-1 text-link hover:underline">{{
                            t(`workspace.directoryRuns.openCard`)
                        }}</RouterLink>
                    </p>
                    <p v-else-if="!inSandbox && sorted.length === 0" class="text-xs text-muted">
                        {{ t(`workspace.directoryRuns.noComputers`) }}
                        <RouterLink to="/capabilities" class="ml-1 text-link hover:underline">{{ t(`workspace.directoryRuns.connectOne`) }}</RouterLink>
                    </p>
                </div>

                <p v-if="entry?.error !== undefined" class="text-danger">{{ entry.error }}</p>

                <!-- What: the targets, flat on the dialog's own surface, one Run each where the place takes it. -->
                <ul class="flex flex-col divide-y divide-line-subtle border-t border-line-subtle">
                    <li v-for="row in rows" :key="row.key" class="flex items-center gap-4 py-3">
                        <div class="flex min-w-0 flex-1 flex-col gap-1" :class="runsAt(row, place) ? `` : `opacity-60`">
                            <div class="flex flex-wrap items-center gap-x-2.5 gap-y-0.5">
                                <span class="font-mono text-sm text-content">{{ row.name }}</span>
                                <span v-if="inSandbox && row.sandbox !== undefined && row.sandbox.running" class="inline-flex items-center gap-1 text-2xs" :class="tintOf(row.sandbox)">
                                    <Icon name="circle" class="text-[0.5rem]" />{{ stateOf(row.sandbox) }}
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
                        <Button
                            v-else
                            class="shrink-0"
                            :label="t(`workspace.directoryRuns.run`)"
                            :aria-label="chosen === undefined ? undefined : t(`workspace.directoryRuns.runOn`, { target: row.name, device: chosen.id })"
                            :title="chosen === undefined ? undefined : t(`workspace.directoryRuns.runTip`, { device: chosen.id })"
                            tier="boring"
                            size="small"
                            :disabled="!runsAt(row, place) || chosen === undefined || chosenBlocked !== undefined"
                            :loading="isPending(row)"
                            @click="runOnComputer(row)"
                        >
                            <template #icon><Icon name="play" class="mr-1.5 text-2xs" /></template>
                        </Button>
                    </li>
                </ul>
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
            <button v-if="entry !== undefined" type="button" :class="ui.textButton({ tone: `quiet` })" :title="entry.path" @click="editFile(entry.path)">
                <Icon name="file-edit" class="text-2xs" />{{ t(`workspace.directoryRuns.editFile`, { file: fileName }) }}
            </button>
            <RouterLink to="/capabilities" :class="ui.textButton({ tone: `quiet` }, `mr-auto`)">
                {{ t(`workspace.directoryRuns.yourComputers`) }} <Icon name="arrow-right" class="text-2xs" />
            </RouterLink>
            <Button :label="t(`ui.action.close`)" tier="quiet" @click="dir = undefined" />
        </template>
    </Modal>
</template>
