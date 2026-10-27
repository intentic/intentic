<script setup lang="ts">
import { SANDBOX_RECOVERY_DAYS as RECOVERY_DAYS, type SandboxSummary } from "@intentic/api-contract";
import { sandboxSubdomain } from "@intentic/sandbox-contract/ids/hostnames";
import { oneLinerFits } from "@intentic/constants";
import { Button, type CommandOs, Meter, Modal, Notice, toneInk } from "@intentic/ui";
import { type NoticeModel, noticeFrom, useNow } from "@intentic/ui/async";
import { useT } from "@intentic/ui/i18n";
import { computed, nextTick, onUnmounted, ref, watch } from "vue";
import { useRouter } from "vue-router";
import RunCommand from "../../../../components/RunCommand.vue";
import StagedProgress from "../../../../components/progress/StagedProgress.vue";
import type { ProgressStep, ProgressStatus } from "../../../../components/progress/stagedSteps";
import { useProgress } from "../../../../components/progress/useProgress";
import { oneLiner } from "../../../../app/environments/scriptCommand";
import { useSandbox } from "../../../../client/sandbox/useSandbox";
import { manageDeviceSandbox } from "../../../../models/sandbox/devices/useDevices";
import { DELETED_PATH } from "../../../../lib/routes/home";
import { sandboxIdFromToken } from "../../../../models/sandbox/sandboxIdFromToken";
import { useNotifications } from "../../../../workbench/notifications/notifications";
import { dismissOperation, useOperation } from "../../../../workbench/operations/operations";
import { beginDeviceWork } from "../../devices/runners/deviceWork";
import type { MachineDoor } from "../../live/sandboxDoors";
import {
    enterStep,
    expectedMs,
    finishStep,
    graceSecondsLeft,
    latestLine,
    REMOVAL_GIVE_UP_MS,
    REMOVAL_GRACE_MS,
    removalKey,
    type RemovalProgress,
    removalSteps,
    type RemovalStep,
    startProgress,
    stepsLeft,
    stepWeight,
} from "./removalPlan";
import RemovalTakes from "./RemovalTakes.vue";
import { openWorkspacePath } from "../switcherPlace";
import { useRemovalDoor } from "./useRemovalDoor";

// REMOVING OR LEAVING A SANDBOX, from the question to the end of the work. One dialog through four moments, because a
// removal is one act and the reader should never lose sight of it between them:
//
//   ask       what goes, what can come back, and whether its container out there goes too;
//   grace     a few seconds in which nothing has happened yet and Undo takes the press back (removalPlan.ts says why
//             this is the only cancel there is);
//   working   the steps it takes, the one it is on, the machine's own latest word, and how long it has run;
//   failed    where it stopped, what was said, and a retry that picks up from there instead of starting over.
//
// The confirm stays in one place throughout and is held while anything runs ("Removing in 4 s", "Removing…"), so a
// second press, or a tenth, lands on a button that does nothing. The run itself lives in the operations ledger under the
// account, not the open sandbox: removing the sandbox on screen switches to another one, and the run must still be
// there to read. Closing the dialog while it works does not stop it; its end is announced wherever the reader is.

const t = useT();

const { target, removeRow } = defineProps<{
    /** The sandbox being asked about; undefined closes the dialog. */
    target: SandboxSummary | undefined;
    /** Drops the account row, as the switcher does it (a member's leave first, and where to go with none left). */
    removeRow: (target: SandboxSummary) => Promise<void>;
}>();

const emit = defineEmits<{
    close: [];
    /** Opens the dialog again on this sandbox: a failure announced while it was closed offers the way back. */
    reopen: [target: SandboxSummary];
}>();

const sandbox = useSandbox();
const router = useRouter();
const { report: notify } = useNotifications();

// The sandbox the dialog DRAWS: the last one it was opened on, kept while it closes so the fade-out shows the moment it
// closed on rather than flipping back to the question, and kept after, so reopening it on the same sandbox finds the run
// that ended while it was shut (a failure to retry from).
const shown = ref<SandboxSummary | undefined>(target);
watch(
    () => target,
    (row) => {
        if (row !== undefined) {
            shown.value = row;
        }
    },
);

const owner = computed(() => shown.value?.role === `owner`);

// The container slug on the hosting machine: the hostname's first label, or a sha256(token)-derived fallback.
const cleanupSlug = ref<string | undefined>(undefined);
watch(
    shown,
    async (row) => {
        // Owner rows only, and an owner's row is the one that carries the token (a member's says null).
        if (row === undefined || row.role !== `owner` || row.token === null) {
            cleanupSlug.value = undefined;
            return;
        }
        if (row.daemonUrl !== null) {
            cleanupSlug.value = new URL(row.daemonUrl).hostname.split(`.`)[0] ?? ``;
            return;
        }
        cleanupSlug.value = sandboxSubdomain(await sandboxIdFromToken(row.token));
    },
    { immediate: true },
);

// The remove one-liner for the device it runs on (recoverable there for 7 days), in the shell the reader picks.
const cleanupCommand = computed(() => {
    const slug = cleanupSlug.value;
    if (slug === undefined || !oneLinerFits(`remove`, [slug])) {
        return undefined;
    }
    return (os: CommandOs): string => oneLiner(`remove`, [slug], os);
});

// The machine running this sandbox, when any of the owner's sandboxes reaches it: then deleting the container out there
// is a checkbox here, and the cleanup command above is only for a machine nothing can reach. Looked up fresh as the
// dialog opens (useRemovalDoor), so the command never stands in for a press that is merely not known yet, and so a
// container an earlier attempt already put away is no longer offered.
const {
    door: cleanupDoor,
    looked: machinesLooked,
    looking: lookingForMachine,
} = useRemovalDoor(
    () => target,
    () => cleanupSlug.value,
);
// Never came up: a container for it exists only where a setup was started and broke, so "none of yours has it" is
// usually the whole story rather than a command's preamble.
const neverCameUp = computed(() => shown.value !== undefined && shown.value.lastSeenAt === null);
const alsoDeleteThere = ref(false);

// THE RUN, one per sandbox, kept beyond this dialog: reopened on the same sandbox, the dialog shows it again.
const removal = useOperation<void, NoticeModel, RemovalProgress>(() => removalKey(shown.value?.id ?? `none`));
const run = removal.operation;
const runProgress = computed(() => run.value?.progress);

// The machine the run deletes on, as it was when the run began: the door is looked up afresh on every open, and a
// container the run already put away is no longer listed there, so a retry still needs to know where it was.
const runDoor = ref<MachineDoor | undefined>(undefined);
const runSlug = ref<string | undefined>(undefined);
const runMachine = computed(() => runDoor.value?.machineLabel);

// THE GRACE: when the press becomes the removal, while that is still ahead.
const graceEndsAt = ref<number | undefined>(undefined);
let graceTimer: ReturnType<typeof setTimeout> | undefined;
const now = useNow(() => graceEndsAt.value !== undefined, 200);
const graceSeconds = computed(() => (graceEndsAt.value === undefined ? 0 : graceSecondsLeft(graceEndsAt.value, now.value)));
const graceShare = computed(() => (graceEndsAt.value === undefined ? 0 : Math.max(0, (graceEndsAt.value - now.value) / REMOVAL_GRACE_MS)));
const stopGrace = (): void => {
    clearTimeout(graceTimer);
    graceTimer = undefined;
    graceEndsAt.value = undefined;
};
// Leaving the shell (the setup page, once the last sandbox is gone) takes this dialog away while a run may still end.
let mounted = true;
onUnmounted(() => {
    mounted = false;
    stopGrace();
});

type Phase = `ask` | `grace` | `working` | `failed` | `done`;
const phase = computed<Phase>(() => {
    const state = run.value?.state;
    if (state === `running`) {
        return `working`;
    }
    if (graceEndsAt.value !== undefined) {
        return `grace`;
    }
    if (state === `failed`) {
        return `failed`;
    }
    return state === `done` ? `done` : `ask`;
});

// A fresh question on every opening: the box that destroys files starts unticked, and no countdown carries over.
watch(
    () => target?.id,
    () => {
        alsoDeleteThere.value = false;
        stopGrace();
    },
);

// The press moves the reader's focus to the one thing they can still do, so a keyboard is never left on a held button.
watch(phase, async (next) => {
    if (next === `grace`) {
        await nextTick();
        document.querySelector<HTMLElement>(`[data-removal-undo]`)?.focus();
    }
});

// What the steps are called, on this sandbox and this machine.
const stepOf = (step: RemovalStep): ProgressStep<RemovalStep> => {
    const steps = runProgress.value?.steps ?? plannedSteps.value;
    const weight = stepWeight(step, steps);
    if (step === `device`) {
        const machine = runMachine.value ?? cleanupDoor.value?.machineLabel ?? ``;
        return { key: step, label: t(`sandbox.removeSandbox.stepDevice`, { machine }), note: t(`sandbox.removeSandbox.stepDeviceNote`), weight };
    }
    return owner.value
        ? { key: step, label: t(`sandbox.removeSandbox.stepAccount`), note: t(`sandbox.removeSandbox.stepAccountNote`), weight }
        : { key: step, label: t(`sandbox.removeSandbox.stepLeave`), note: t(`sandbox.removeSandbox.stepLeaveNote`), weight };
};
const deletesThere = computed(() => alsoDeleteThere.value && cleanupDoor.value !== undefined && cleanupSlug.value !== undefined);
const plannedSteps = computed(() => removalSteps(owner.value && shown.value?.hosted === null && deletesThere.value));
const shownSteps = computed(() => (runProgress.value?.steps ?? plannedSteps.value).map(stepOf));

const progress = useProgress(
    () => run.value?.startedAt,
    () => ({ endedAt: run.value?.endedAt, expectedMs: run.value?.expectedMs, giveUpMs: run.value?.giveUpMs }),
);
const STATUS = { working: `running`, failed: `stopped`, done: `done` } as const satisfies Record<`working` | `failed` | `done`, ProgressStatus>;
const showLog = ref(false);
watch(phase, (next) => {
    if (next === `failed` && run.value?.lines.length !== 0) {
        showLog.value = true;
    }
    if (next === `ask` || next === `grace`) {
        showLog.value = false;
    }
});

const failedOn = computed(() => (phase.value === `failed` ? runProgress.value?.stage : undefined));

// THE WORK. Every step is safe to ask for twice (removalPlan.ts), so a retry runs what is left and nothing else.
interface Plan {
    readonly row: SandboxSummary;
    readonly steps: readonly RemovalStep[];
    readonly done: readonly RemovalStep[];
    readonly door: MachineDoor | undefined;
    readonly slug: string | undefined;
}

const deleteThere = async (row: SandboxSummary, door: MachineDoor, slug: string, line: (text: string) => void): Promise<void> => {
    const doing = t(`sandbox.deviceOps.workingRemove`, { name: row.name });
    // The machine's card and the Devices tile carry it while the reader looks elsewhere.
    const endMark = beginDeviceWork({
        machine: door.machineKey,
        sandboxes: [row.id],
        doing,
        what: t(`sandbox.deviceOps.doingOn`, { doing, machine: door.machineLabel }),
    });
    try {
        // Carried by the door itself where it can (this computer, through the app, from a local window), else by whichever
        // of the owner's sandboxes reaches that machine. When that is the box being deleted, its daemon dies relaying the
        // call, so the stream ends instead of answering; that is the removal landing, and only a refusal the device sent
        // still counts as a failure.
        await (door.carry?.(slug) ??
            manageDeviceSandbox(door.hostId, slug, `remove`, {
                severing: door.severs,
                at: door.relay === sandbox.activeSandboxId.value ? undefined : door.relay,
                onLine: line,
            }));
    } finally {
        endMark();
    }
};

// One step of a plan: the container out there, or the account row.
const runStep = async (plan: Plan, step: RemovalStep, line: (text: string) => void): Promise<void> => {
    if (step === `account`) {
        await removeRow(plan.row);
        return;
    }
    if (plan.door === undefined || plan.slug === undefined) {
        throw new Error(t(`sandbox.removeSandbox.machineGone`));
    }
    await deleteThere(plan.row, plan.door, plan.slug, line);
};

// The app's sentence for a step that failed: whose step it was, in the reader's words.
const failedSentence = (plan: Plan, step: RemovalStep): string => {
    if (step === `device`) {
        return t(`sandbox.sandboxSwitcher.couldntDeleteThere`, { machine: plan.door?.machineLabel ?? `` });
    }
    return plan.row.role === `owner`
        ? t(`sandbox.removeSandbox.couldntRemove`, { name: plan.row.name })
        : t(`sandbox.removeSandbox.couldntLeave`, { name: plan.row.name });
};

// How it ended, said once: a receipt with the way to Recently deleted, or (with the dialog shut or on another sandbox)
// the failure where the reader is, with the way back to the retry.
const announce = (row: SandboxSummary, outcome: { readonly state: string; readonly failure: NoticeModel | undefined }): void => {
    const watching = mounted && target?.id === row.id;
    const ownRow = row.role === `owner`;
    if (outcome.state === `done`) {
        if (watching) {
            emit(`close`);
        } else {
            // Nobody will open a dialog on a row that is gone, so the run is put away here rather than on the next open.
            dismissOperation(removalKey(row.id));
        }
        notify({
            tone: `done`,
            title: ownRow ? t(`sandbox.removeSandbox.removed`, { name: row.name }) : t(`sandbox.removeSandbox.left`, { name: row.name }),
            detail: ownRow ? t(`sandbox.removeSandbox.removedDetail`, { count: RECOVERY_DAYS }, RECOVERY_DAYS) : undefined,
            actions: ownRow
                ? [{ label: t(`sandbox.removeSandbox.openDeleted`), run: () => void openWorkspacePath(router, DELETED_PATH) }]
                : undefined,
        });
        return;
    }
    if (!watching && outcome.failure !== undefined) {
        notify({
            tone: `problem`,
            title: outcome.failure.title,
            detail: outcome.failure.detail,
            actions: [{ label: t(`shell.operations.show`), run: () => emit(`reopen`, row) }],
        });
    }
};

const execute = async (plan: Plan): Promise<void> => {
    const { row } = plan;
    runDoor.value = plan.door;
    runSlug.value = plan.slug;
    let at: RemovalStep = plan.steps[0] ?? `account`;
    const left = stepsLeft(plan);
    const begun = (): RemovalProgress => startProgress(plan.steps, plan.done, Date.now());
    const outcome = await removal.run({
        what: row.role === `owner` ? t(`sandbox.removeSandbox.removing`, { name: row.name }) : t(`sandbox.removeSandbox.leaving`, { name: row.name }),
        progress: begun(),
        expectedMs: expectedMs(left),
        giveUpMs: left.includes(`device`) ? REMOVAL_GIVE_UP_MS : undefined,
        // Said by announce(), in the reader's own place whether the dialog is open or not.
        quiet: true,
        failed: (error) => noticeFrom(error, failedSentence(plan, at)),
        task: async (report) => {
            for (const step of left) {
                at = step;
                report.progress((previous) => enterStep(previous ?? begun(), step, Date.now()));
                await runStep(plan, step, report.line);
                report.progress((previous) => finishStep(previous ?? begun(), step));
            }
        },
    });
    if (outcome !== undefined) {
        announce(row, outcome);
    }
};

// The press: the countdown starts, and only its end starts the work.
const begin = (): void => {
    const row = shown.value;
    if (row === undefined || phase.value !== `ask`) {
        return;
    }
    const door = cleanupDoor.value;
    const slug = cleanupSlug.value;
    const steps = plannedSteps.value;
    graceEndsAt.value = Date.now() + REMOVAL_GRACE_MS;
    graceTimer = setTimeout(() => {
        graceTimer = undefined;
        graceEndsAt.value = undefined;
        void execute({ row, steps, done: [], door, slug });
    }, REMOVAL_GRACE_MS);
};

// Taken back inside the grace: nothing happened, so there is nothing to say beyond the dialog going.
const undo = (): void => {
    stopGrace();
    emit(`close`);
};

// From where it stopped. "Account only" is the way on when the machine out there refuses or cannot be reached: the
// row goes, and the command to delete the container by hand is on the Devices tab and in the next dialog.
const retry = (accountOnly: boolean): void => {
    const row = shown.value;
    const previous = runProgress.value;
    if (row === undefined || previous === undefined || removal.busy.value) {
        return;
    }
    const steps = accountOnly ? removalSteps(false) : previous.steps;
    void execute({ row, steps, done: previous.done, door: cleanupDoor.value ?? runDoor.value, slug: cleanupSlug.value ?? runSlug.value });
};

// Esc, the mask or the corner's cross: inside the grace it is Undo; while the work runs it only hides the dialog.
const onOpen = (open: boolean): void => {
    if (open) {
        return;
    }
    if (phase.value === `grace`) {
        undo();
        return;
    }
    emit(`close`);
};

const header = computed(() => {
    const name = shown.value?.name ?? ``;
    if (phase.value === `ask`) {
        return owner.value ? t(`sandbox.removeAsk.titleRemove`, { name }) : t(`sandbox.removeAsk.titleLeave`, { name });
    }
    if (phase.value === `failed`) {
        return owner.value ? t(`sandbox.removeSandbox.stoppedRemoving`, { name }) : t(`sandbox.removeSandbox.couldntLeave`, { name });
    }
    return owner.value ? t(`sandbox.removeSandbox.removing`, { name }) : t(`sandbox.removeSandbox.leaving`, { name });
});

// What the press itself does, in one line. The machine out there is NOT in it: on a box of the reader's own that is the
// tick box's business alone, and a line up here naming the machine read as if the press deleted it there.
const lead = computed(() => {
    if (!owner.value) {
        return t(`sandbox.removeAsk.leadLeave`);
    }
    return shown.value?.hosted === null ? t(`sandbox.removeAsk.leadOwn`) : t(`sandbox.removeAsk.leadHosted`);
});

// THE CONFIRM'S WIDTH, held from the press on. Its words change every second of the grace and again as the work
// starts; measured once the countdown is drawn, the button keeps that width to the end instead of twitching with them.
const confirmButton = ref<{ $el?: Element } | null>(null);
const confirmMinWidth = ref<number | undefined>(undefined);
watch(phase, async (next, previous) => {
    if (next === `ask`) {
        confirmMinWidth.value = undefined;
        return;
    }
    if (next === `grace` && previous === `ask`) {
        await nextTick();
        const element = confirmButton.value?.$el;
        confirmMinWidth.value = element instanceof HTMLElement ? element.getBoundingClientRect().width : undefined;
    }
});

// The one sentence beside the clock: what can still be done about it.
const heading = computed(() => {
    if (phase.value === `failed`) {
        return t(`sandbox.removeSandbox.headingFailed`);
    }
    return phase.value === `done` ? t(`sandbox.removeSandbox.headingDone`) : t(`sandbox.removeSandbox.headingWorking`);
});

// What a retry from here does, so "Try again" is never a guess.
const failedHint = computed(() => {
    const machine = runMachine.value ?? ``;
    if (failedOn.value === `device`) {
        return t(`sandbox.removeSandbox.deviceFailedHint`, { machine });
    }
    return runProgress.value?.done.includes(`device`) === true ? t(`sandbox.removeSandbox.accountFailedAfterDevice`, { machine }) : undefined;
});

// The confirm's words through every moment, in one place, so the button the reader pressed is where they look.
const confirmLabel = computed(() => {
    if (phase.value === `grace`) {
        return owner.value
            ? t(`sandbox.removeSandbox.removingIn`, { seconds: graceSeconds.value })
            : t(`sandbox.removeSandbox.leavingIn`, { seconds: graceSeconds.value });
    }
    if (phase.value === `working` || phase.value === `done`) {
        return owner.value ? t(`sandbox.removeSandbox.removingNow`) : t(`sandbox.removeSandbox.leavingNow`);
    }
    return owner.value ? t(`ui.action.remove`) : t(`ui.action.leave`);
});
</script>

<template>
    <Modal :open="target !== undefined" size="md" class="ui-dialog-confirm" :header="header" @update:open="onOpen">
        <template v-if="shown !== undefined">
            <!-- THE QUESTION, read top to bottom in one pass: what the press does, what goes with it, what can come back,
                 and the one choice. Short labels, never paragraphs: the reader skims this dialog on the way to its
                 button. Marks are kept for the one promise (restorable); the rest is words, so nothing competes. -->
            <div v-if="phase === 'ask'" class="flex flex-col gap-5">
                <p class="text-content">{{ lead }}</p>

                <!-- Only the owner's removal takes anything or promises anything back; a member leaving has the one line. -->
                <template v-if="shown.role === 'owner'">
                    <RemovalTakes :hosted="shown.hosted !== null" />

                    <!-- The hosted lane's machine goes with it anyway, so the choice below is only for a box of the reader's own. -->
                    <div v-if="shown.hosted === null && cleanupCommand !== undefined" class="border-t border-line pt-4">
                        <!-- One of the owner's sandboxes reaches the machine holding it, so this is a tick box rather than a
                             command: the same removal the Devices tab's own button runs. It is the only place the machine
                             is named, and its note says what each state of the box means there, so the consequence is
                             read beside the choice that makes it. -->
                        <label v-if="cleanupDoor !== undefined" class="flex cursor-pointer items-start gap-2.5">
                            <!-- Same plain box the extension cards use; the kit has no checkbox component, on purpose. -->
                            <input v-model="alsoDeleteThere" type="checkbox" class="mt-1 shrink-0" />
                            <span class="flex min-w-0 flex-col">
                                <span class="text-content">
                                    {{ t(`sandbox.removeAsk.alsoDelete`) }} <span class="font-medium">{{ cleanupDoor.machineLabel }}</span>
                                </span>
                                <span :class="alsoDeleteThere ? toneInk(`danger`, `text-xs`) : `text-xs text-subtle`">
                                    {{
                                        alsoDeleteThere
                                            ? t(`sandbox.removeAsk.alsoDeleteNote`)
                                            : t(`sandbox.removeAsk.alsoDeleteOff`, { machine: cleanupDoor.machineLabel })
                                    }}
                                </span>
                            </span>
                        </label>
                        <!-- Not found YET: the fresh reads are out, and a command drawn now was most often replaced by the tick
                             box a second later. -->
                        <p v-else-if="lookingForMachine" class="flex items-center gap-2 text-subtle">
                            <Icon name="spinner" spin class="shrink-0 text-xs" />
                            {{ t(`sandbox.sandboxSwitcher.lookingOnMachines`) }}
                        </p>
                        <div v-else class="flex flex-col gap-2">
                            <!-- Said only as a reading: machines that listed what they hold, and none holds it. -->
                            <p v-if="machinesLooked.length > 0" class="text-subtle">
                                {{
                                    neverCameUp
                                        ? t(`sandbox.sandboxSwitcher.neverCameUpNotOn`, { machines: machinesLooked.join(`, `) })
                                        : t(`sandbox.sandboxSwitcher.notOnMachines`, { machines: machinesLooked.join(`, `) })
                                }}
                            </p>
                            <p class="text-subtle">
                                {{
                                    neverCameUp && machinesLooked.length > 0
                                        ? t(`sandbox.sandboxSwitcher.startedElsewhere`)
                                        : t(`sandbox.removeAsk.runThere`)
                                }}
                            </p>
                            <RunCommand :command="cleanupCommand" :label="t(`sandbox.sandboxSwitcher.cleanupCommand`)" />
                        </div>
                    </div>
                </template>
            </div>

            <!-- THE GRACE: what is about to happen, a bar running down to it, and nothing touched yet. -->
            <div v-else-if="phase === 'grace'" class="flex flex-col gap-3" role="status" aria-live="polite">
                <p class="text-content tabular-nums">{{ t(`sandbox.removeSandbox.startsIn`, { seconds: graceSeconds }) }}</p>
                <Meter
                    :value="graceShare"
                    tone="muted"
                    :label="t(`sandbox.removeSandbox.countdown`)"
                    :valuetext="t(`sandbox.removeSandbox.secondsLeft`, { seconds: graceSeconds })"
                />
                <ol class="flex flex-col gap-1.5">
                    <li v-for="step in shownSteps" :key="step.key" class="flex items-center gap-2 text-muted">
                        <Icon name="circle" class="shrink-0" />
                        <span class="text-2xs">{{ step.label }}</span>
                    </li>
                </ol>
            </div>

            <!-- THE WORK, and where it stopped: the steps, the one it is on, the machine's own latest word. -->
            <div v-else-if="run !== undefined && runProgress !== undefined" class="flex flex-col gap-3">
                <StagedProgress
                    v-model:log="showLog"
                    :heading="heading"
                    :progress="progress ?? { elapsedMs: undefined }"
                    :steps="shownSteps"
                    :stage="runProgress.stage"
                    :stage-at="runProgress.stageAt"
                    :ended-at="run.endedAt"
                    :status="STATUS[phase === 'failed' ? 'failed' : phase === 'done' ? 'done' : 'working']"
                    :live="phase === 'working'"
                    :detail="runProgress.stage === 'device' ? latestLine(run.lines) : undefined"
                    :lines="run.lines"
                    :empty-log="t(`sandbox.removeSandbox.emptyLog`, { machine: runMachine ?? `` })"
                    :show-log-label="t(`sandbox.removeSandbox.showLog`)"
                    :hide-log-label="t(`sandbox.removeSandbox.hideLog`)"
                    hide-dismiss
                />
                <template v-if="phase === 'failed'">
                    <!-- Whose step failed as the title, in the app's words; what the machine or the platform said under it. -->
                    <Notice v-if="run.failure" :of="run.failure" class="text-2xs" />
                    <p v-if="failedHint" class="text-2xs text-muted">{{ failedHint }}</p>
                </template>
            </div>
        </template>

        <template #footer>
            <!-- Left: the way out, which means something different in each moment. -->
            <!-- allow(buttons): in the grace period Undo is the one live press; the confirm beside it only holds its countdown. -->
            <Button v-if="phase === 'grace'" :label="t(`ui.action.undo`)" tier="accent" data-removal-undo @click="undo" />
            <Button v-else :label="phase === 'ask' ? t(`ui.action.cancel`) : t(`ui.action.close`)" tier="quiet" @click="onOpen(false)" />
            <Button
                v-if="phase === 'failed' && failedOn === 'device' && owner"
                :label="t(`sandbox.removeSandbox.accountOnly`)"
                tier="boring"
                @click="retry(true)"
            />
            <!-- Right: the confirm, held in place from the press to the end, so presses after the first fall on nothing. -->
            <Button tier="accent" v-if="phase === 'failed'" :label="t(`ui.action.tryAgain`)" tone="danger" autofocus @click="retry(false)">
                <template #icon><Icon name="refresh" /></template>
            </Button>
            <Button
                tier="accent"
                v-else
                ref="confirmButton"
                :label="confirmLabel"
                tone="danger"
                class="tabular-nums"
                :style="confirmMinWidth === undefined ? undefined : { minWidth: `${confirmMinWidth}px` }"
                :autofocus="phase === 'ask'"
                :disabled="phase !== 'ask'"
                :loading="phase === 'working'"
                @click="begin"
            >
                <template #icon><Icon :name="phase === 'grace' ? 'clock' : 'trash'" /></template>
            </Button>
        </template>
    </Modal>
</template>
