import type { DeviceAgentOp, DeviceSandboxOp, DeviceSyncSwitch } from "@intentic/sandbox-contract";
import type { DeviceSandboxGroup, NoticeModel, ResourcesForm, RollbackChoice, SandboxVerb } from "@intentic/ui";
import { runningShape } from "@intentic/ui/sandbox-resources";
import { rollbackToPrompt, sandboxVerbPrompt, VERB_LABEL } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { computed, type ComputedRef, type Ref, ref } from "vue";
import { agentFallback, sandboxFallback, syncFallback } from "./deviceFallback";
import { agentRefusal, type AgentRun, type LinksAsked } from "./agentRun";
import { agentInFlight, agentRunOf, beginDeviceWork, dismissAgentRun, machineCalling, pressAgent, sandboxesWorking } from "./deviceWork";
import { canSetShape, type ShapeIntent, shapeFlow, shapeSevers, tooOldToSave } from "../shapeFlow";
import {
    type BatchAction,
    type BatchVerb,
    type DeviceRow,
    folderOwner,
    isSelfMachine,
    type MachineRow,
    managerOf,
    removableHere,
    rowRemoval,
} from "../deviceRows";
import { type DeviceSandboxPayload, manageDeviceSandbox, revokeSyncDevice, runDeviceAgentFlow, runDeviceCommand } from "../useDevices";
import { useSandbox } from "../../client/useSandbox";
import { t } from "@intentic/ui/i18n";

// Everything one device page does TO its machine: the container verbs, the two sync switches, the agent's
// own two ops, and revoking the enrollment. One op at a time per machine, since a mirroring switch racing a
// container verb on the same pairing would be two answers about the same ports. A machine with several
// environments (Windows and the distros on it) is still one page and one lock: container verbs go through
// whichever door is open, and the ops that belong to one environment's agent or enrollment name it.
// Everything that runs is entered in the device-work ledger (deviceWork.ts) for as long as it runs, which is what the
// board's cards, the hub's Devices row and the rail's tile turn for, and what holds the lock across a remount: the page
// is gone the moment the reader goes back to the board, and the work is not.

// Which machine op each verb sends; only `resources` differs from its verb name (the kit's word for the
// form vs. the machine's word for what Apply does).
const OP: Record<SandboxVerb, DeviceSandboxOp> = {
    start: `start`,
    stop: `stop`,
    restart: `restart`,
    update: `update`,
    rollback: `rollback`,
    resources: `reshape`,
    logs: `logs`,
    remove: `remove`,
};

// Ops that end this browser's own connection when aimed at the sandbox serving it. `reshape` belongs here like
// the rest: it recreates the container, so the relay carrying the call dies with it and no result frame can
// arrive. Its own dialog warns beforehand — a separate question from what a dropped stream MEANS afterwards,
// and leaving it out made a reshape that worked report "Lost contact with that device".
const SEVERING = new Set<DeviceSandboxOp>([`stop`, `restart`, `update`, `rebuild`, `rollback`, `remove`, `reshape`]);

// Everything this page can do to one machine's file sync: the switches over a pairing that exists, and the one that
// starts one. Enrolling belongs with them rather than in the add-a-device dialog — a folder on a machine already
// connected is a toggle on its row, not a one-liner to paste.
export type SyncCommand = DeviceSyncSwitch | "sync-install" | "sync-clean";

// Pause/resume and mirror on/off are one button wearing two labels; the label flips on the next report, not
// the click, so a spinner must answer to either direction.
const PAIRED_WITH: Partial<Record<SyncCommand, SyncCommand>> = {
    "sync-pause": `sync-resume`,
    "sync-resume": `sync-pause`,
    "mirror-off": `mirror-on`,
    "mirror-on": `mirror-off`,
    "mirror-ignore": `mirror-unignore`,
    "mirror-unignore": `mirror-ignore`,
};

// Kept beside each other rather than inlined at each call site, so a verb and its failure sentence can't
// drift apart.
// `sync-install` rides these too: turning sync ON is the same kind of act as the switches beside it, and the row it
// is pressed on is the row its answer belongs under.
const COMMAND_REFUSAL: Record<SyncCommand, string> = {
    "mirror-off": `That device didn't change its port mirroring.`,
    "mirror-on": `That device didn't change its port mirroring.`,
    "mirror-ignore": `That device didn't change what it does with that port.`,
    "mirror-unignore": `That device didn't change what it does with that port.`,
    "sync-pause": `That device didn't pause its file syncing.`,
    "sync-resume": `That device didn't resume its file syncing.`,
    "sync-unpair": `That device didn't unpair this sandbox.`,
    "sync-install": `That device didn't start syncing this sandbox.`,
    "sync-clean": `That device didn't clear the build output holding its deletions back.`,
};

const COMMAND_UNREACHED: Record<SyncCommand, string> = {
    "mirror-off": `Couldn't reach that device to change its port mirroring.`,
    "mirror-on": `Couldn't reach that device to change its port mirroring.`,
    "mirror-ignore": `Couldn't reach that device to change what it does with that port.`,
    "mirror-unignore": `Couldn't reach that device to change what it does with that port.`,
    "sync-pause": `Couldn't reach that device to pause its file syncing.`,
    "sync-resume": `Couldn't reach that device to resume its file syncing.`,
    "sync-unpair": `Couldn't reach that device to unpair this sandbox.`,
    "sync-install": `Couldn't reach that device to start syncing this sandbox.`,
    "sync-clean": `Couldn't reach that device to clear the build output holding its deletions back.`,
};

// Update and restart both stop the resident process carrying the request, so the page can't claim an
// outcome: it shows what was watched, then this, and the confirmation is the next poll's version. The
// connection dropping isn't announced here — the log says it in the moment it happens.
const AGENT_ASKED: Record<DeviceAgentOp, string> = {
    upgrade: `Updating. The new version shows here when its loop comes back.`,
    restart: `Restarting. This page catches up when its loop comes back.`,
    // The machine restarts its agent against the links it has left, so this page hears the new count the same way it
    // hears a new version: on the loop's next hello, not from this request.
    "forget-unreachable": `Dropping the links that stopped answering. The count here catches up when its loop comes back.`,
};

// What the Devices row and the machine's card say while one of these is out on a machine. `logs` is absent: reading a
// tail is not work being done to anything, and a row that marks it would be marking almost every visit.
const VERB_WORKING: Partial<Record<SandboxVerb, string>> = {
    start: `Starting`,
    stop: `Stopping`,
    restart: `Restarting`,
    update: `Updating`,
    rollback: `Rolling back`,
    resources: `Resizing`,
    remove: `Removing`,
};

const SYNC_WORKING: Record<SyncCommand, string> = {
    "mirror-off": `Turning port mirroring off`,
    "mirror-on": `Turning port mirroring on`,
    "mirror-ignore": `Taking a port off localhost`,
    "mirror-unignore": `Putting a port back on localhost`,
    "sync-pause": `Pausing file syncing`,
    "sync-resume": `Resuming file syncing`,
    "sync-unpair": `Unpairing this sandbox`,
    "sync-install": `Setting file syncing up`,
    "sync-clean": `Clearing build output`,
};

const AGENT_WORKING: Record<DeviceAgentOp, string> = {
    upgrade: `Updating a machine's agents`,
    restart: `Restarting a device's agent`,
    "forget-unreachable": `Dropping a device's dead links`,
};

const counted = (count: number, one: string, many: string): string => `${count} ${count === 1 ? one : many}`;

// A batch's one answer, in the verb's own tense: "3 sandboxes stopped", "1 sandbox didn't stop".
const BATCH_DONE: Record<Exclude<BatchVerb, `remove`>, string> = { start: `started`, stop: `stopped`, restart: `restarted`, update: `updated` };
const BATCH_REFUSED: Record<Exclude<BatchVerb, `remove`>, string> = {
    start: `didn't start`,
    stop: `didn't stop`,
    restart: `didn't restart`,
    update: `didn't update`,
};

/** The device's own sentence, whatever shape it arrived in. */
const refusalText = (error: unknown): string => (error instanceof Error ? error.message : `that device didn't say why`);

// What agreeing to a removal does, counted over the rows it was asked for. One line per half, because they are
// unlike: the first ends a sandbox, the second only stops this machine keeping a copy of one.
const removalEffects = (label: string, containers: number, pairings: number): string[] => [
    ...(containers === 0
        ? []
        : [
              `${counted(containers, `sandbox is`, `sandboxes are`)} deleted on ${label}: the container, its files and its history. ` +
                  `Running "ic sandbox restore" there brings one back for a week.`,
          ]),
    ...(pairings === 0
        ? []
        : [
              `${counted(pairings, `sandbox stops`, `sandboxes stop`)} syncing and mirroring ports on ${label}. ` +
                  `The folders already on that device are left exactly as they are.`,
          ]),
];

/** The same two halves once they have happened, for the line under the list. */
const removalSettled = (containers: number, pairings: number): string[] => [
    ...(containers === 0 ? [] : [`${counted(containers, `sandbox`, `sandboxes`)} deleted`]),
    ...(pairings === 0 ? [] : [`${counted(pairings, `pairing`, `pairings`)} ended`]),
];

/** One container verb's payload: what its shape flow carries, the kept version a rollback goes to, and its log's sink. */
const actPayload = (
    flow: { readonly payload: DeviceSandboxPayload } | undefined,
    to: string | undefined,
    onLine: (line: string) => void,
    severing: boolean,
): DeviceSandboxPayload => {
    const payload: DeviceSandboxPayload = { ...flow?.payload, onLine, severing };
    if (to !== undefined) {
        payload.to = to;
    }
    return payload;
};

/** The machine's mark for a verb that does something, and an inert end for one that only reads. */
const markVerb = (machine: MachineRow, group: DeviceSandboxGroup, verb: SandboxVerb): (() => void) => {
    const says = VERB_WORKING[verb];
    if (says === undefined) {
        return (): void => {};
    }
    const doing = `${says} ${group.title}`;
    return beginDeviceWork({ machine: machine.key, sandboxes: [group.sandboxId], doing, what: `${doing} on ${machine.label}` });
};

/** One mark over every row a run was asked for, said with and without the machine's name. */
const markRun = (machine: MachineRow, groups: readonly DeviceSandboxGroup[], doing: string, where: string): (() => void) =>
    beginDeviceWork({ machine: machine.key, sandboxes: groups.map((group) => group.sandboxId), doing, what: `${doing} ${where} ${machine.label}` });

/** The question a removal asks, over one row or several. */
export interface RemovalPrompt {
    readonly header: string;
    readonly effects: readonly string[];
    /** The sandboxes by name: nobody should have to agree to a count. */
    readonly names: readonly string[];
    /** Whether one of them is the sandbox serving this page, which goes with it. Only ever a single-row removal. */
    readonly severing: boolean;
}

/** The one batch verb that asks first: an update takes each sandbox offline while it restarts onto a new image. */
export interface BatchPrompt {
    readonly header: string;
    readonly body: string;
    readonly names: readonly string[];
    readonly label: string;
}

/** How far a batch has got, for the bar that started it. */
export interface BatchProgress {
    readonly verb: BatchVerb;
    readonly done: number;
    readonly total: number;
}

/** A verb waiting on its question; `choice` names the kept version a rollback goes to, when it is not the one before. */
export interface PendingAct {
    readonly group: DeviceSandboxGroup;
    readonly verb: SandboxVerb;
    readonly choice?: RollbackChoice;
}

export interface ActPrompt {
    readonly header: string;
    readonly body: string | undefined;
    /** Whether agreeing takes down the connection this page is watching through; nothing that reaches here destroys. */
    readonly severing: boolean;
    readonly label: string;
}

/**
 * One press that didn't work, filed under the key of the control that was pressed. `command` is the same act as a
 * line to type on the machine itself, offered because the reason a device press fails is usually that this route to
 * it is shut — a switch it won't grant, an agent too old for the verb — and pressing again can't open it.
 */
export interface OpFailure {
    readonly key: string;
    readonly notice: NoticeModel;
    readonly command?: string;
}

export interface DeviceOps {
    /** True while anything at all is running on this machine; every button reads it as `disabled`. */
    readonly working: ComputedRef<boolean>;
    readonly rowKey: (group: DeviceSandboxGroup) => string;
    // Two keys per environment, not one: the switches and the enrollment each report where they were pressed, and a
    // single key would print one op's answer under another's controls. The agent's answer is its run's (agentRun).
    readonly switchKey: (environment: DeviceRow) => string;
    readonly accessKey: (environment: DeviceRow) => string;
    readonly failure: Ref<OpFailure | undefined>;
    readonly outcome: Ref<{ key: string; message: string } | undefined>;

    // Container verbs, through whichever door is open. `choice` names one of the older versions the machine kept for a
    // rollback to go to, rather than the one before (rollbackChoices.ts).
    readonly act: (group: DeviceSandboxGroup, verb: SandboxVerb, choice?: RollbackChoice) => void;
    readonly runningVerb: (group: DeviceSandboxGroup) => SandboxVerb | undefined;
    readonly verbRunning: (group: DeviceSandboxGroup) => boolean;
    readonly lines: (group: DeviceSandboxGroup) => readonly string[];
    readonly logShown: (group: DeviceSandboxGroup) => boolean;
    readonly confirmingAct: Ref<PendingAct | undefined>;
    readonly actPrompt: ComputedRef<ActPrompt | undefined>;
    readonly confirmAct: () => void;
    readonly reshaping: Ref<{ group: DeviceSandboxGroup } | undefined>;
    readonly applyReshape: (shape: ResourcesForm) => void;
    readonly saveReshape: (shape: ResourcesForm | undefined) => void;
    readonly selfGroup: (group: DeviceSandboxGroup) => boolean;

    // Letting this machine go of one sandbox or of several: per row the container verb, the unpair command, or both,
    // in whatever combination that row holds. One key for the whole run, since one press asked for all of it.
    readonly confirmingRemoval: Ref<readonly DeviceSandboxGroup[] | undefined>;
    readonly removalPrompt: ComputedRef<RemovalPrompt | undefined>;
    readonly confirmRemoval: () => void;
    readonly removing: Ref<boolean>;

    // One verb over every ticked row that can take it (deviceRows.ts `batchActions`), one row at a time, with one
    // answer for the whole list under `listKey` — the rows it was about may be the ones that just left.
    readonly runBatch: (action: BatchAction) => void;
    readonly confirmingBatch: Ref<BatchAction | undefined>;
    readonly batchPrompt: ComputedRef<BatchPrompt | undefined>;
    readonly confirmBatch: () => void;
    readonly batchProgress: Ref<BatchProgress | undefined>;
    readonly listKey: string;
    /** The sandbox a run is working on right now, so its row can say so while it happens. */
    readonly workingIds: ComputedRef<readonly string[]>;

    // Everything one machine's file sync can be told to do: the switches over a pairing, and the one that starts
    // one. `mode`/`localDir` ride enrolling alone, and are what pick the environment that ends up running mutagen;
    // `port` rides the two per-port mirror switches and nothing else.
    readonly runSync: (
        environment: DeviceRow,
        key: string,
        sandboxId: string | undefined,
        command: SyncCommand,
        about?: { readonly mode?: "sync" | "mirror"; readonly localDir?: string; readonly port?: number },
    ) => Promise<void>;
    // `port` narrows the spinner to the one row that was pressed: six ports under one key would otherwise all spin.
    readonly syncRunning: (key: string, command: SyncCommand, port?: number) => boolean;
    readonly confirmingUnpair: Ref<{ environment: DeviceRow; group: DeviceSandboxGroup } | undefined>;
    readonly confirmUnpair: () => void;

    // One agent op, sent through this environment's door. An update moves every side of the machine from there.
    readonly runAgent: (environment: DeviceRow, op: DeviceAgentOp) => Promise<void>;
    /** Which of this environment's ops is in flight, its agent's return included; a row has one thing to say. */
    readonly agentOp: (environment: DeviceRow) => DeviceAgentOp | undefined;
    // The last press on this environment's agent as one thing with a state (agentRun.ts), per environment rather than
    // the page's one slot, so a Restart on one side and an Update through another keep theirs. Held by the ledger, so
    // a run pressed before the reader went back to the board is still here when they return.
    readonly agentRun: (environment: DeviceRow) => AgentRun | undefined;
    /** Puts a finished run away; a run still going stays, since it is the only thing saying so. */
    readonly dismissAgent: (environment: DeviceRow) => void;

    // Cutting one environment's enrollment off entirely.
    readonly confirmingRevoke: Ref<DeviceRow | undefined>;
    readonly revoking: Ref<boolean>;
    readonly runRevoke: () => Promise<void>;
}

export function useDeviceOps(machine: () => MachineRow, refetch: () => void): DeviceOps {
    // The sandbox serving this page, by its container slug on the machine: the daemon's own hostname, same
    // derivation the switcher and setup CLI use.
    const { daemonUrl } = useSandbox();
    const ownSlug = computed(() => (daemonUrl.value === undefined ? undefined : new URL(daemonUrl.value).hostname.split(`.`)[0]));

    const switchKey = (environment: DeviceRow): string => `${environment.device.key}:switches`;
    const accessKey = (environment: DeviceRow): string => `${environment.device.key}:access`;
    const rowKey = (group: DeviceSandboxGroup): string => `${machine().key}:${group.sandboxId}`;
    const selfGroup = (group: DeviceSandboxGroup): boolean => isSelfMachine(machine(), group, ownSlug.value);
    // Whether this verb on this row takes down the connection the page is watching it through: what the dialog warns
    // about beforehand, and what makes a dead stream the answer rather than a failure afterwards.
    const severs = (group: DeviceSandboxGroup, verb: SandboxVerb): boolean => selfGroup(group) && SEVERING.has(OP[verb]);

    // `${rowKey}:${verb}`, so one string says both which row is working and at what.
    const busy = ref<string | undefined>();
    // Kept out of `busy`, which also drives which container-verb button spins; keyed by row and command,
    // since three buttons on a row must not spin together. The port joins the key for the two per-port switches,
    // whose buttons all sit on one row under one key.
    const syncBusy = ref<{ key: string; command: SyncCommand; port: number | undefined } | undefined>();
    const revoking = ref(false);
    const removing = ref(false);
    // A batch between its first row and its last; `busy` alone goes quiet between two rows.
    const batchProgress = ref<BatchProgress | undefined>();
    // The row a removal is on, which `busy` does not carry: a removal is two halves, only one of them a container verb.
    const removingRow = ref<string | undefined>();
    // The ledger's word too, which is the only one that survives a remount: work started before the reader went back
    // to the board is still running on the machine, and a second press through the same door would race it.
    const working = computed(
        () =>
            busy.value !== undefined ||
            syncBusy.value !== undefined ||
            revoking.value ||
            removing.value ||
            batchProgress.value !== undefined ||
            machineCalling(machine().key),
    );

    const failure = ref<OpFailure | undefined>();
    const outcome = ref<{ key: string; message: string } | undefined>();
    // Keyed by row, so leaving one row's log on screen while reading another's is fine.
    const runLines = ref<Record<string, string[]>>({});
    // Which row's pane survives once nothing is running: `logs` is read after the op ends, unlike every
    // other op whose lines were only progress.
    const openLog = ref<string | undefined>();

    const verbRunning = (group: DeviceSandboxGroup): boolean => busy.value?.startsWith(`${rowKey(group)}:`) === true;
    const logShown = (group: DeviceSandboxGroup): boolean => openLog.value === rowKey(group);
    const lines = (group: DeviceSandboxGroup): readonly string[] => runLines.value[rowKey(group)] ?? [];

    // Splits the row's own verb back out of the single-string `busy`, since only one op runs at a time.
    const runningVerb = (group: DeviceSandboxGroup): SandboxVerb | undefined => {
        const prefix = `${rowKey(group)}:`;
        return busy.value?.startsWith(prefix) === true ? (busy.value.slice(prefix.length) as SandboxVerb) : undefined;
    };

    const confirmingAct = ref<PendingAct | undefined>();
    // The rows one press asked to let go of, and the one key their answer lands under: a run over four rows has one
    // reason it went wrong, said once, rather than four notices under four rows nobody pressed.
    const confirmingRemoval = ref<readonly DeviceSandboxGroup[] | undefined>();
    const listKey = `${machine().key}:list`;
    const confirmingBatch = ref<BatchAction | undefined>();
    const reshaping = ref<{ group: DeviceSandboxGroup } | undefined>();
    const confirmingUnpair = ref<{ environment: DeviceRow; group: DeviceSandboxGroup } | undefined>();
    const confirmingRevoke = ref<DeviceRow | undefined>();

    const actPrompt = computed<ActPrompt | undefined>(() => {
        const pending = confirmingAct.value;
        if (pending === undefined) {
            return undefined;
        }
        const asked =
            pending.choice === undefined ? sandboxVerbPrompt(pending.verb, pending.group.title) : rollbackToPrompt(pending.group.title, pending.choice.version);
        // `logs` never confirms, so indexing the label past it is safe.
        const label = VERB_LABEL[pending.verb as Exclude<SandboxVerb, `logs`>];
        return {
            // A verb with no prompt of its own only reaches here by severing, so the fallback still asks a
            // real question.
            header: asked?.header ?? `${label} ${pending.group.title}?`,
            body: asked?.body,
            severing: severs(pending.group, pending.verb),
            label,
        };
    });

    // The door container verbs travel through; undefined when no environment holds a socket.
    const door = (): string | undefined => managerOf(machine())?.device.hostId;

    // `resources` is the one verb with something to say beyond its name: the form's whole shape and when it takes
    // effect (shapeFlow says which op carries it). A save or a forget touches no container, so nothing is severed even
    // on the sandbox serving this page. `to` is the older version a rollback goes to, when it is not the one before.
    const runAct = async (group: DeviceSandboxGroup, verb: SandboxVerb, intent?: ShapeIntent, to?: string): Promise<void> => {
        const hostId = door();
        const slug = group.sandbox?.slug;
        if (hostId === undefined || slug === undefined || working.value) {
            return;
        }
        const share = group.sandbox?.resources;
        // Whether the machine's ic takes the contract's shape: which op carries it, and how the typed fallback spells it.
        const facts = managerOf(machine())?.device.facts;
        const takesSet = canSetShape(facts);
        // When it can't save for the next restart, the agent's own sentence about its stale ic outranks "update the agent".
        const tooOld = tooOldToSave(facts);
        let flow: ReturnType<typeof shapeFlow> | undefined;
        try {
            flow = intent === undefined || share === undefined ? undefined : shapeFlow(intent, takesSet, runningShape(share), tooOld);
        } catch (error) {
            failure.value = { key: rowKey(group), notice: noticeFrom(error, tooOld) };
            return;
        }
        const key = rowKey(group);
        busy.value = `${key}:${verb}`;
        failure.value = undefined;
        outcome.value = undefined;
        runLines.value = { ...runLines.value, [key]: [] };
        // Opened before lines arrive, so an empty pane reads as "reading" rather than an ignored click.
        openLog.value = verb === `logs` ? key : undefined;
        const endMark = markVerb(machine(), group, verb);
        const payload = actPayload(
            flow,
            to,
            (line) => (runLines.value = { ...runLines.value, [key]: [...(runLines.value[key] ?? []), line] }),
            // The same severing the dialog warned about: losing the stream is the answer, not a failure to report.
            (intent === undefined || shapeSevers(intent)) && severs(group, verb),
        );
        try {
            const message = await manageDeviceSandbox(hostId, slug, flow?.op ?? OP[verb], payload);
            // A log tail's result line would only restate the pane above it, so it's left to be the answer.
            outcome.value = verb === `logs` ? undefined : { key, message };
        } catch (error) {
            failure.value = { key, notice: noticeFrom(error, t(`sandbox.deviceOps.didntWorkOnDevice`)), command: sandboxFallback(verb, slug, intent, { takesSet, to }) };
            if (verb === `logs`) {
                openLog.value = undefined;
            }
        } finally {
            busy.value = undefined;
            endMark();
            // Always, including after failure: a flow that stopped halfway still changed the machine, so the
            // row must reflect what's there now.
            if (verb !== `logs`) {
                refetch();
            }
        }
    };

    // A row whose share wasn't reported has nothing to open the form on.
    const openResources = (group: DeviceSandboxGroup): void => {
        if (group.sandbox?.resources === undefined) {
            failure.value = {
                key: rowKey(group),
                notice: {
                    tone: `warning`,
                    title: t(`sandbox.deviceOps.deviceDidntReportSandboxs`),
                    // Names the button on this very page, not a command: the agent flow does the upgrade from here.
                    detail: t(`sandbox.deviceOps.refreshTryAgainKeeps`),
                },
            };
            return;
        }
        reshaping.value = { group };
    };

    const act = (group: DeviceSandboxGroup, verb: SandboxVerb, choice?: RollbackChoice): void => {
        if (working.value) {
            return;
        }
        // ONE REMOVAL IN THE PRODUCT. The menu's Remove is the list's own act, so a container can never be taken
        // while the enrollment that pointed at it stays behind — which is how a machine collects rows for sandboxes
        // that no longer exist. Asked before the container check: a row holding only files removes too.
        if (verb === `remove`) {
            if (removableHere(machine(), group)) {
                confirmingRemoval.value = [group];
            }
            return;
        }
        if (door() === undefined || group.sandbox === undefined) {
            return;
        }
        if (verb === `resources`) {
            openResources(group);
            return;
        }
        // The log button toggles: reopening what you closed is the same click, not a second control.
        if (verb === `logs` && openLog.value === rowKey(group)) {
            openLog.value = undefined;
            // Cleared with the pane it described, so no result line floats under a row with nothing near it.
            outcome.value = undefined;
            return;
        }
        // A rollback always asks, and a chosen version is named in the question.
        if (sandboxVerbPrompt(verb, group.title) !== undefined || severs(group, verb)) {
            confirmingAct.value = choice === undefined ? { group, verb } : { group, verb, choice };
            return;
        }
        void runAct(group, verb);
    };

    const confirmAct = (): void => {
        const pending = confirmingAct.value;
        confirmingAct.value = undefined;
        if (pending !== undefined) {
            void runAct(pending.group, pending.verb, undefined, pending.choice?.to);
        }
    };

    const reshapeWith = (intent: ShapeIntent): void => {
        const pending = reshaping.value;
        reshaping.value = undefined;
        if (pending !== undefined) {
            void runAct(pending.group, `resources`, intent);
        }
    };
    const applyReshape = (shape: ResourcesForm): void => reshapeWith({ shape, when: `now` });
    const saveReshape = (shape: ResourcesForm | undefined): void => reshapeWith(shape === undefined ? { forget: true } : { shape, when: `nextRestart` });

    const removalPrompt = computed<RemovalPrompt | undefined>(() => {
        const pending = confirmingRemoval.value;
        if (pending === undefined || pending.length === 0) {
            return undefined;
        }
        const taken = pending.map((group) => rowRemoval(machine(), group));
        const label = machine().label;
        return {
            header: pending.length === 1 ? `Remove ${pending[0]?.title} from ${label}?` : `Remove ${pending.length} sandboxes from ${label}?`,
            effects: removalEffects(label, taken.filter((removal) => removal.container).length, taken.filter((removal) => removal.pairing).length),
            names: pending.map((group) => group.title),
            severing: pending.some((group) => severs(group, `remove`)),
        };
    });

    /** The container half, through whichever door is open; the refusal, or undefined for done. */
    const removeContainer = async (group: DeviceSandboxGroup): Promise<string | undefined> => {
        const hostId = door();
        const slug = group.sandbox?.slug;
        if (hostId === undefined || slug === undefined) {
            return `no open door onto that container`;
        }
        // The stream dies with the container when this is the sandbox serving the page, so that drop is the answer
        // rather than a failure — which is what the dialog warned about, and why `removalOrder` puts the unpair first.
        return await manageDeviceSandbox(hostId, slug, `remove`, { severing: severs(group, `remove`) }).then(
            () => undefined,
            (error: unknown) => refusalText(error),
        );
    };

    /** The enrollment half, through the FOLDER's own door, which on a many-sided machine is not the container's. */
    const endPairing = async (group: DeviceSandboxGroup): Promise<string | undefined> => {
        const pairHost = folderOwner(machine(), group)?.device.hostId;
        if (pairHost === undefined) {
            return `no open door onto that pairing`;
        }
        return await runDeviceCommand(pairHost, `sync-unpair`, { sandboxId: group.sandboxId }).then(
            (result) => (result.ok ? undefined : result.message),
            (error: unknown) => refusalText(error),
        );
    };

    // CONTAINER BEFORE PAIRING, except on the sandbox serving this page. An enrollment outlives a removal that
    // failed, so it is left pointing at something that still exists rather than at a hole — but removing THIS sandbox
    // takes down the daemon that would have carried the unpair, so there the order reverses or the pairing is
    // stranded on the device with nothing left here able to end it.
    const removalOrder = (group: DeviceSandboxGroup): readonly (`container` | `pairing`)[] =>
        severs(group, `remove`) ? [`pairing`, `container`] : [`container`, `pairing`];

    // What the machine refused is returned rather than thrown, so the rows queued behind this one still run: they
    // were asked for together, but nothing about one of them decides another.
    const removeRow = async (group: DeviceSandboxGroup): Promise<{ container: boolean; pairing: boolean; refusal: string | undefined }> => {
        const removal = rowRemoval(machine(), group);
        const done = { container: false, pairing: false };
        for (const half of removalOrder(group)) {
            if (!removal[half]) {
                continue;
            }
            const refusal = half === `container` ? await removeContainer(group) : await endPairing(group);
            if (refusal !== undefined) {
                return { ...done, refusal };
            }
            done[half] = true;
        }
        return { ...done, refusal: undefined };
    };

    // The run's one answer, under the key the press came from. A refusal names the rows that stayed AND what did come
    // off, since a run that half worked is neither a success nor a failure and must not read as either.
    const sayRemoval = (settled: readonly string[], refused: readonly string[]): void => {
        if (refused.length === 0) {
            // Nothing done is still something to say: a poll landing between the dialog and the press can leave a
            // row with neither half still on this machine.
            const said = settled.length === 0 ? `already held none of them` : settled.join(`, `);
            outcome.value = { key: listKey, message: `${machine().label}: ${said}.` };
            return;
        }
        failure.value = {
            key: listKey,
            notice: {
                tone: `warning`,
                title: `${counted(refused.length, `sandbox`, `sandboxes`)} stayed on ${machine().label}.`,
                detail: [...refused, ...(settled.length === 0 ? [] : [`What did come off: ${settled.join(`, `)}.`])].join(` · `),
            },
        };
    };

    const runRemoval = async (groups: readonly DeviceSandboxGroup[]): Promise<void> => {
        if (working.value || groups.length === 0) {
            return;
        }
        removing.value = true;
        failure.value = undefined;
        outcome.value = undefined;
        const endMark = markRun(machine(), groups, `Removing ${counted(groups.length, `sandbox`, `sandboxes`)}`, `from`);
        let containers = 0;
        let pairings = 0;
        const refused: string[] = [];
        batchProgress.value = { verb: `remove`, done: 0, total: groups.length };
        try {
            for (const [index, group] of groups.entries()) {
                removingRow.value = group.sandboxId;
                // oxlint-disable-next-line eslint/no-await-in-loop -- one row at a time: every row goes through the same door
                const done = await removeRow(group);
                containers += done.container ? 1 : 0;
                pairings += done.pairing ? 1 : 0;
                if (done.refusal !== undefined) {
                    refused.push(`${group.title}: ${done.refusal}`);
                }
                batchProgress.value = { verb: `remove`, done: index + 1, total: groups.length };
            }
        } finally {
            removing.value = false;
            removingRow.value = undefined;
            batchProgress.value = undefined;
            endMark();
            // Always, including after a refusal: a run that stopped halfway still changed the machine.
            refetch();
        }
        sayRemoval(removalSettled(containers, pairings), refused);
    };

    const confirmRemoval = (): void => {
        const pending = confirmingRemoval.value;
        confirmingRemoval.value = undefined;
        if (pending !== undefined) {
            void runRemoval(pending);
        }
    };

    // A container verb over several rows: one at a time through the one door, a refusal on one row never stopping the
    // rest, and one answer for the run. No row here is the sandbox serving the page (`batchable`), so nothing severs.
    const runContainerBatch = async (verb: Exclude<BatchVerb, `remove`>, groups: readonly DeviceSandboxGroup[]): Promise<void> => {
        const hostId = door();
        if (hostId === undefined || working.value || groups.length === 0) {
            return;
        }
        failure.value = undefined;
        outcome.value = undefined;
        const endMark = markRun(machine(), groups, `${VERB_WORKING[verb] ?? verb} ${counted(groups.length, `sandbox`, `sandboxes`)}`, `on`);
        let settled = 0;
        const refused: string[] = [];
        batchProgress.value = { verb, done: 0, total: groups.length };
        try {
            for (const [index, group] of groups.entries()) {
                const slug = group.sandbox?.slug;
                if (slug === undefined) {
                    refused.push(`${group.title}: no container on this device`);
                    continue;
                }
                busy.value = `${rowKey(group)}:${verb}`;
                // oxlint-disable-next-line eslint/no-await-in-loop -- one row at a time: every row goes through the same door
                const refusal = await manageDeviceSandbox(hostId, slug, OP[verb]).then(
                    () => undefined,
                    (error: unknown) => refusalText(error),
                );
                if (refusal === undefined) {
                    settled += 1;
                } else {
                    refused.push(`${group.title}: ${refusal}`);
                }
                batchProgress.value = { verb, done: index + 1, total: groups.length };
            }
        } finally {
            busy.value = undefined;
            batchProgress.value = undefined;
            endMark();
            // Always, including after a refusal: a run that stopped halfway still changed the machine.
            refetch();
        }
        if (refused.length === 0) {
            outcome.value = { key: listKey, message: `${machine().label}: ${counted(settled, `sandbox`, `sandboxes`)} ${BATCH_DONE[verb]}.` };
            return;
        }
        failure.value = {
            key: listKey,
            notice: {
                tone: `warning`,
                title: `${counted(refused.length, `sandbox`, `sandboxes`)} ${BATCH_REFUSED[verb]} on ${machine().label}.`,
                detail: [...refused, ...(settled === 0 ? [] : [`${counted(settled, `sandbox`, `sandboxes`)} ${BATCH_DONE[verb]}.`])].join(` · `),
            },
        };
    };

    // Remove asks with its own dialog (both halves, named per effect), Update asks because each sandbox goes offline
    // while it restarts onto a new image, and the three power verbs just run: each is undone by its opposite.
    const runBatch = (action: BatchAction): void => {
        if (working.value || action.groups.length === 0) {
            return;
        }
        if (action.verb === `remove`) {
            confirmingRemoval.value = action.groups;
            return;
        }
        if (action.verb === `update`) {
            confirmingBatch.value = action;
            return;
        }
        void runContainerBatch(action.verb, action.groups);
    };

    const batchPrompt = computed<BatchPrompt | undefined>(() => {
        const pending = confirmingBatch.value;
        if (pending === undefined) {
            return undefined;
        }
        return {
            header: `Update ${counted(pending.groups.length, `sandbox`, `sandboxes`)} on ${machine().label}?`,
            body:
                `Each one restarts onto the newest image and is unavailable while that happens — seconds if the update is ` +
                `already downloaded, a few minutes if not. Their files are kept.`,
            names: pending.groups.map((group) => group.title),
            label: VERB_LABEL.update,
        };
    });

    const confirmBatch = (): void => {
        const pending = confirmingBatch.value;
        confirmingBatch.value = undefined;
        if (pending !== undefined && pending.verb !== `remove`) {
            void runContainerBatch(pending.verb, pending.groups);
        }
    };

    // The row a run is on right now: a container verb's row by its busy key, a removal's by the row it reached. With
    // nothing running from this mount, the ledger's rows: a verb pressed before the page was last left is still out.
    const workingIds = computed<readonly string[]>(() => {
        if (removingRow.value !== undefined) {
            return [removingRow.value];
        }
        const held = busy.value;
        if (held === undefined) {
            return sandboxesWorking(machine().key);
        }
        const group = machine().groups.find((candidate) => held.startsWith(`${rowKey(candidate)}:`));
        return group === undefined || runningVerb(group) === `logs` ? [] : [group.sandboxId];
    });

    // No confirmation for the reversible four; `sync-unpair` alone routes through the dialog. `sandboxId`
    // present targets one pairing, absent runs the bare machine-wide CLI form. The environment named here is the door
    // the line is SENT to; which environment ends up running it is the daemon's call, made from the folder
    // (hosts/device-commands.ts) — mutagen can only watch the filesystem that holds it.
    const runSync = async (
        environment: DeviceRow,
        key: string,
        sandboxId: string | undefined,
        command: SyncCommand,
        about?: { readonly mode?: "sync" | "mirror"; readonly localDir?: string; readonly port?: number },
    ): Promise<void> => {
        const hostId = environment.device.hostId;
        if (hostId === undefined || working.value) {
            return;
        }
        syncBusy.value = { key, command, port: about?.port };
        failure.value = undefined;
        outcome.value = undefined;
        const endMark = beginDeviceWork({
            machine: machine().key,
            sandboxes: sandboxId === undefined ? [] : [sandboxId],
            doing: SYNC_WORKING[command],
            what: `${SYNC_WORKING[command]} on ${environment.device.label}`,
        });
        try {
            const result = await runDeviceCommand(hostId, command, { sandboxId, ...about });
            // The machine's own sentence either way: a refusal names the switch to flip rather than throwing.
            outcome.value = result.ok ? { key, message: result.message } : undefined;
            failure.value = result.ok
                ? undefined
                : {
                      key,
                      notice: { tone: `warning`, title: COMMAND_REFUSAL[command], detail: result.message },
                      command: syncFallback(command, sandboxId, about?.port),
                  };
        } catch (error) {
            failure.value = { key, notice: noticeFrom(error, COMMAND_UNREACHED[command]), command: syncFallback(command, sandboxId, about?.port) };
        } finally {
            syncBusy.value = undefined;
            endMark();
            // Blocks on a fresh read rather than serving the pre-click list, since the daemon dropped its
            // cached reading as the command ran.
            refetch();
        }
    };

    const syncRunning = (key: string, command: SyncCommand, port?: number): boolean =>
        syncBusy.value?.key === key &&
        syncBusy.value.port === port &&
        (syncBusy.value.command === command || syncBusy.value.command === PAIRED_WITH[command]);

    // Unpairing doesn't undo itself (a fresh one-liner re-enrolls), so it parks in the app's own dialog like
    // the container verbs.
    const confirmUnpair = (): void => {
        const pending = confirmingUnpair.value;
        confirmingUnpair.value = undefined;
        if (pending !== undefined) {
            void runSync(pending.environment, rowKey(pending.group), pending.group.sandboxId, `sync-unpair`);
        }
    };

    // An update moves every side of the machine from whichever door it went through; the other ops, that door's alone.
    const movedBy = (environment: DeviceRow, op: DeviceAgentOp): readonly DeviceRow[] =>
        op === `upgrade` ? machine().environments.filter((side) => side.device.hostId !== undefined) : [environment];

    // The count the concern offering the drop was showing, taken at the press: the machine applies the same rule to
    // the same stamps (device/config.ts `unreachableIn`), so it is the number it goes on to drop.
    const linksAsked = (environment: DeviceRow, op: DeviceAgentOp): LinksAsked | undefined => {
        const links = environment.device.facts?.links;
        return op === `forget-unreachable` && links !== undefined ? { total: links.total, unreachable: links.unreachable } : undefined;
    };

    // The run lives in the ledger rather than here: the call ending is not the answer (the agent coming back is), and
    // the page that pressed is usually gone by the time it arrives. Each side the press moved waits for its own agent;
    // the shell's watcher (watchDeviceReturns) reads the machine back and answers each wait as it does.
    const runAgent = async (environment: DeviceRow, op: DeviceAgentOp): Promise<void> => {
        const hostId = environment.device.hostId;
        const moved = movedBy(environment, op);
        // A side still coming back from the last press is not asked again: a second update over one still installing races it.
        if (hostId === undefined || working.value || moved.some((side) => agentInFlight(side.device.key) !== undefined)) {
            return;
        }
        const press = pressAgent({
            machine: machine().key,
            what: `${AGENT_WORKING[op]} on ${machine().label}`,
            op,
            door: environment.device,
            moved: moved.map((side) => side.device),
            waiting: AGENT_ASKED[op],
            links: linksAsked(environment, op),
        });
        try {
            const { message } = await runDeviceAgentFlow(hostId, op, { onLine: press.line });
            // Only the device's own sentence, and only if it managed to send one; no fallback text.
            if (message !== undefined) {
                press.answered(message);
            }
        } catch (error) {
            // A refusal, not a lost connection: the client only throws for a frame the device actually sent.
            press.refused({ notice: noticeFrom(error, agentRefusal(op)), command: agentFallback(op) });
        } finally {
            press.ended();
            // The version is the answer, so ask for it; the tab's own poll picks it up as the loop comes back.
            refetch();
        }
    };

    // Drops the key from the sandbox rather than asking the device to clean up (Unpair does that): the only
    // path that works for a laptop that's lost, wiped, or someone else's.
    const runRevoke = async (): Promise<void> => {
        const environment = confirmingRevoke.value;
        const enrollment = environment?.device.sync;
        // The enrollment may have vanished between opening the dialog and confirming it; nothing left to
        // revoke closes it quietly.
        if (environment === undefined || enrollment === undefined) {
            confirmingRevoke.value = undefined;
            return;
        }
        const key = accessKey(environment);
        const label = environment.device.label;
        revoking.value = true;
        failure.value = undefined;
        outcome.value = undefined;
        try {
            await revokeSyncDevice(enrollment.machine);
            outcome.value = { key, message: t(`sandbox.deviceOps.noLongerAccessTo`, { label }) };
        } catch (error) {
            failure.value = { key, notice: noticeFrom(error, t(`sandbox.deviceOps.couldntRevokeAccess`)) };
        } finally {
            confirmingRevoke.value = undefined;
            revoking.value = false;
            // The row is losing its enrollment either way, so refetch regardless of whether the call itself
            // succeeded.
            refetch();
        }
    };

    return {
        working,
        rowKey,
        switchKey,
        accessKey,
        failure,
        outcome,
        act,
        runningVerb,
        verbRunning,
        lines,
        logShown,
        confirmingAct,
        actPrompt,
        confirmAct,
        reshaping,
        applyReshape,
        saveReshape,
        selfGroup,
        confirmingRemoval,
        removalPrompt,
        confirmRemoval,
        removing,
        runBatch,
        confirmingBatch,
        batchPrompt,
        confirmBatch,
        batchProgress,
        listKey,
        workingIds,
        runSync,
        syncRunning,
        confirmingUnpair,
        confirmUnpair,
        runAgent,
        agentOp: (environment) => agentInFlight(environment.device.key),
        agentRun: (environment) => agentRunOf(environment.device.key),
        dismissAgent: (environment) => dismissAgentRun(environment.device.key),
        confirmingRevoke,
        revoking,
        runRevoke,
    };
}
