<!-- THE NEW SANDBOX'S RUN, held where leaving its page does not end it (newSandbox.ts says why). Mounted by the shell on a
     desktop while Home asks for the new sandbox or a run is under way, keyed by `newSandboxGeneration` so a run that
     ended leaves nothing behind for the next. Draws nothing: the dialog, the page and the rail's tile draw what it
     publishes. Once the press has gone somewhere it closes the dialog by taking the ask out of Home's address, so the
     reader is back on the chat they were in; a first sandbox, with no chat to go back to, keeps its page. An address
     asking to finish a setup left unfinished (`?finish=<id>`) is that press, made for the reader: no dialog, the row's
     own run. `?machine=hosted` (and its `tier=`) picks a machine of ours in the dialog; `?found=` is where its reader
     lands once it is open (lib/foundOnComputer.ts).
     A READER ELSEWHERE IS TOLD WHAT CHANGED (2026-11-22): inside another sandbox the rail's tile is a small thing to watch,
     so a run that needs their answer, or stopped, stands in the notification lane for as long as that is true, with the
     press that shows it, and one that became ready says so once with the press that opens it. Nobody is moved. -->
<script setup lang="ts">
import type { SandboxSummary } from "@intentic/api-contract";
import { computed, onMounted, onUnmounted, ref, watch } from "vue";
import { useRoute, useRouter } from "vue-router";
import { useSandbox } from "../../../client/sandbox/useSandbox";
import { FOUND_QUERY, foundAfterSetup, landingAfterSetup } from "../../../lib/foundOnComputer";
import { HOME_PATH } from "../../../lib/routes/firstScreens";
import { finishableSandboxes, switchableSandboxes } from "../../../models/sandbox/live/roster";
import { HOSTED } from "../../setup/add/useAddSandbox";
import { useAddSandboxHere } from "../../setup/add/useAddSandboxHere";
import { useSetupRunProgress } from "../../setup/progress/useSetupRunProgress";
import { useT } from "@intentic/ui/i18n";
import { ADD_SANDBOX_HOME_PATH } from "../../../models/sandbox/addSandbox";
import { useNotifications } from "../../../workbench/notifications/notifications";
import { desktopGauge, hostedGauge, machineGauge, type NewSandboxGauge } from "./newSandboxGauge";
import {
    finishAskedBy,
    machineAskedBy,
    markReady,
    newSandbox,
    newSandboxBusy,
    newSandboxGeneration,
    newSandboxShownBy,
    type NewSandboxRun,
    readNewSandbox,
    seenReady,
    tierAskedBy,
} from "./newSandbox";

const route = useRoute();
const router = useRouter();
const watching = computed(() => newSandboxShownBy(route));

const pressed = ref(false);
const opening = ref(false);
const resumed = ref(false);
// The row being finished, kept for a press again after its code was refused.
let finished: SandboxSummary | undefined;
// How the run ended, decided once: whatever answers after that (a navigation this host made, a late report) is not news.
let settled = false;

// Over: the shell mounts the next host if Home still asks for one, and none otherwise.
const end = (): void => {
    newSandboxBusy.value = false;
    newSandboxGeneration.value += 1;
};

// What the desktop app found signed in on this computer, named by the address that asked: offered once it is open.
const found = route.query[FOUND_QUERY];

// Opened: into the new sandbox, on its own first screen, or on its Sandbox ▸ Models when the app found AI tools signed in
// here (landingAfterSetup). Dismissed: Home's own chat again, where the one the reader had is selected.
const leave = async (opened: boolean): Promise<void> => {
    if (watching.value) {
        await router.replace(opened ? landingAfterSetup(here.add.created.value?.id, foundAfterSetup(found)) : HOME_PATH);
    }
    end();
};

const t = useT();
const notifications = useNotifications();

// In the reader's list now, a tile like the rest; one they were not watching says it is ready until it is opened, and
// the notification lane says so once, with the press that opens it where a watching reader would have landed.
const readyUnseen = (sandboxId: string): void => {
    if (settled) {
        return;
    }
    settled = true;
    markReady(sandboxId);
    const name = here.add.created.value?.name ?? ``;
    const landing = landingAfterSetup(sandboxId, foundAfterSetup(found));
    notifications.report({
        tone: `done`,
        title: t(`home.newSandbox.toast.ready`, { name }),
        actions: [
            {
                label: t(`ui.action.open`),
                tier: `accent`,
                run: () => {
                    seenReady(sandboxId);
                    void router.push(landing);
                },
            },
        ],
    });
    end();
};

const here = useAddSandboxHere({
    appStays: true,
    tier: tierAskedBy(route),
    // Only a reader looking at it is moved onto it; one back in another sandbox's chat stays there.
    selects: () => watching.value,
    reportedIn: (sandboxId) => {
        if (watching.value) {
            opening.value = true;
            return;
        }
        readyUnseen(sandboxId);
    },
});
onMounted(() => void here.add.read());
// A machine of ours asked for by the address is the dialog's pick, while one can start; the form says why when not.
if (machineAskedBy(route) === `hosted`) {
    here.add.pick.value = HOSTED;
}

// Left while its first start was still on screen: it is ready enough to be a tile, and the reader chose another.
watch(watching, (now) => {
    const id = here.add.created.value?.id;
    if (!now && opening.value && id !== undefined) {
        readyUnseen(id);
    }
});

// Started: the dialog goes, and the reader with another sandbox is back on its chat while the tile carries the run. The
// address is replaced, not pushed, so Back still leads where it led before the + was pressed.
const sandbox = useSandbox();
watch(
    () => here.add.started.value !== undefined,
    (now, before) => {
        const id = here.add.created.value?.id;
        const others = switchableSandboxes(sandbox.sandboxes.value).some((box) => box.id !== id);
        if (now && !before && watching.value && others) {
            void router.replace(HOME_PATH);
        }
    },
);

// HOW FAR IT HAS GOT, whichever way it runs (newSandboxGauge.ts), read here where the run lives so the tile, the cluster and
// This computer's page say it while its own page is not on screen. A machine's lines are read by the engine its page
// reads them with.
const onMachine = useSetupRunProgress({
    lines: () => here.add.onMachine.run.lines.value,
    running: () => here.add.onMachine.run.busy.value,
    failed: () => here.add.onMachine.run.failure.value !== undefined,
});
// When the press went somewhere, for a lane that does not note its own start.
const startedAt = ref<number>();
watch(
    () => here.add.started.value,
    (now) => {
        startedAt.value = now === undefined ? undefined : (startedAt.value ?? Date.now());
    },
    { immediate: true },
);
const laneGauge = (): NewSandboxGauge | undefined => {
    switch (here.add.started.value?.kind) {
        case `here`: {
            const report = here.desktopReport.value;
            return report === undefined ? undefined : desktopGauge(report);
        }
        case `machine`: {
            const read = onMachine.value;
            return read === undefined ? undefined : machineGauge(read);
        }
        case `hosted`:
            return here.add.hostedRow.value === null || here.add.hostedWait.value.failure !== undefined ? undefined : hostedGauge(here.add.hostedWait.value.steps);
        default:
            return undefined;
    }
};
const gauge = computed((): NewSandboxGauge | undefined => {
    if (here.add.started.value === undefined) {
        return undefined;
    }
    const read = laneGauge() ?? { share: undefined };
    return { ...read, startedAt: read.startedAt ?? startedAt.value };
});

const { blocked, busy } = here.add;
const run: NewSandboxRun = {
    here,
    pressed,
    opening,
    resumed,
    gauge,
    create: async () => {
        // A press the form would not take starts nothing, and puts up no tile that would stand for nothing.
        if (blocked.value || busy.value) {
            return;
        }
        pressed.value = true;
        newSandboxBusy.value = true;
        await here.add.create();
    },
    resume: async (row, asked) => {
        if (busy.value || here.add.started.value !== undefined) {
            return;
        }
        finished = row;
        resumed.value = true;
        pressed.value = true;
        newSandboxBusy.value = true;
        await here.add.resume(row, asked);
    },
    retry: () => {
        if (resumed.value && here.add.started.value === undefined && finished !== undefined) {
            void run.resume(finished);
            return;
        }
        void here.add.retry();
    },
    opened: () => {
        if (settled || here.add.created.value === null) {
            return;
        }
        settled = true;
        void leave(true);
    },
    dismiss: () => {
        if (settled) {
            return;
        }
        settled = true;
        void leave(false);
    },
};
newSandbox.value = run;

// What needs the reader while they are elsewhere: an answer the run waits for, or a run that stopped. It stands as long
// as that is true and the reader is not on its page; put away, it stays away until the run stands somewhere else.
const putAway = ref<string | undefined>();
const stopHolding = notifications.hold(`new-sandbox`, () => {
    const reading = readNewSandbox(run);
    if (reading === undefined || watching.value || (reading.phase !== `asking` && reading.phase !== `failed`) || putAway.value === reading.phase) {
        return undefined;
    }
    const name = reading.name === `` ? t(`home.newSandbox.title`) : reading.name;
    const phase = reading.phase;
    return {
        kind: `condition`,
        tone: phase === `failed` ? `danger` : `warning`,
        title: phase === `failed` ? t(`home.newSandbox.toast.failed`, { name }) : t(`home.newSandbox.toast.asking`, { name }),
        actions: [{ label: phase === `failed` ? t(`home.newSandbox.toast.seeWhy`) : t(`home.newSandbox.toast.show`), tier: `accent`, run: () => void router.push(ADD_SANDBOX_HOME_PATH) }],
        dismiss: () => {
            putAway.value = phase;
        },
    };
});

// Asked by the address to finish a row: pressed for the reader once the account's list names it as theirs and unfinished,
// or as theirs and removed from its machine (the removed notice's "Set it up again"). A row the list does not offer (a stale link, someone else's) asks nothing, and Home's chat comes back.
watch(
    () => [finishAskedBy(route), sandbox.sandboxes.value] as const,
    ([asked, rows]) => {
        if (asked === undefined || pressed.value) {
            return;
        }
        const row = finishableSandboxes(rows).find((entry) => entry.id === asked);
        if (row !== undefined) {
            void run.resume(row, machineAskedBy(route));
        } else {
            void router.replace(HOME_PATH);
        }
    },
    { immediate: true },
);
onUnmounted(() => {
    stopHolding();
    if (newSandbox.value === run) {
        newSandbox.value = undefined;
    }
});
</script>

<template>
    <span hidden></span>
</template>
