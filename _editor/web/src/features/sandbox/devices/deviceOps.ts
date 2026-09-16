import type { DeviceAgentOp, DeviceSandboxOp, DeviceSyncSwitch } from "@intentic/sandbox-contract";
import type { DeviceSandboxGroup, NoticeModel, ResourcesAsk, SandboxVerb } from "@intentic/ui";
import { sandboxVerbPrompt, VERB_LABEL } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { computed, type ComputedRef, type Ref, ref, watch } from "vue";
import { type DeviceRow, isSelfMachine, type MachineRow, managerOf } from "./deviceRows";
import { manageDeviceSandbox, revokeSyncDevice, runDeviceAgentFlow, runDeviceCommand } from "./useDevices";
import { useSandbox } from "../client/useSandbox";
import { type HubWork, useHubWork } from "../../../shell/hub/hubWork";

// Everything one device page does TO its machine: the container verbs, the two sync switches, the agent's
// own two ops, and revoking the enrollment. One op at a time per machine, since a mirroring switch racing a
// container verb on the same pairing would be two answers about the same ports. A machine with several
// environments (Windows and the distros on it) is still one page and one lock: container verbs go through
// whichever door is open, and the ops that belong to one environment's agent or enrollment name it.

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

// Ops that end this browser's own connection when aimed at the sandbox serving it; `resources` carries its
// own warning instead.
const SEVERING = new Set<DeviceSandboxOp>([`stop`, `restart`, `update`, `rebuild`, `rollback`, `remove`]);

// Everything this page can do to one machine's file sync: the switches over a pairing that exists, and the one that
// starts one. Enrolling belongs with them rather than in the add-a-device dialog — a folder on a machine already
// connected is a toggle on its row, not a one-liner to paste.
type SyncCommand = DeviceSyncSwitch | "sync-install" | "sync-clean";

// Pause/resume and mirror on/off are one button wearing two labels; the label flips on the next report, not
// the click, so a spinner must answer to either direction.
const PAIRED_WITH: Partial<Record<SyncCommand, SyncCommand>> = {
    "sync-pause": `sync-resume`,
    "sync-resume": `sync-pause`,
    "mirror-off": `mirror-on`,
    "mirror-on": `mirror-off`,
};

// Kept beside each other rather than inlined at each call site, so a verb and its failure sentence can't
// drift apart.
// `sync-install` rides these too: turning sync ON is the same kind of act as the switches beside it, and the row it
// is pressed on is the row its answer belongs under.
const COMMAND_REFUSAL: Record<SyncCommand, string> = {
    "mirror-off": `That device didn't change its port mirroring.`,
    "mirror-on": `That device didn't change its port mirroring.`,
    "sync-pause": `That device didn't pause its file syncing.`,
    "sync-resume": `That device didn't resume its file syncing.`,
    "sync-unpair": `That device didn't unpair this sandbox.`,
    "sync-install": `That device didn't start syncing this sandbox.`,
    "sync-clean": `That device didn't clear the build output holding its deletions back.`,
};

const COMMAND_UNREACHED: Record<SyncCommand, string> = {
    "mirror-off": `Couldn't reach that device to change its port mirroring.`,
    "mirror-on": `Couldn't reach that device to change its port mirroring.`,
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
};

// What the Devices row says while one of these is out on a machine, as a continuation of the section's own name.
// `logs` is absent: reading a tail is not work being done to anything, and a row that marks it would be marking
// almost every visit.
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
    "sync-pause": `Pausing file syncing`,
    "sync-resume": `Resuming file syncing`,
    "sync-unpair": `Unpairing this sandbox`,
    "sync-install": `Setting file syncing up`,
    "sync-clean": `Clearing build output`,
};

const AGENT_WORKING: Record<DeviceAgentOp, string> = { upgrade: `Updating a device's agent`, restart: `Restarting a device's agent` };

/** The row's mark for a verb that does something, and an inert end for one that only reads. */
const markVerb = (hubWork: HubWork, group: DeviceSandboxGroup, verb: SandboxVerb): (() => void) => {
    const says = VERB_WORKING[verb];
    return says === undefined ? (): void => {} : hubWork.begin(`${says} ${group.title}`);
};

export interface ActPrompt {
    readonly header: string;
    readonly body: string | undefined;
    /** A destructive warning and a self-severing warning are two different facts, so this rides the prompt. */
    readonly severing: boolean;
    readonly label: string;
    readonly destructive: boolean;
}

export interface DeviceOps {
    /** True while anything at all is running on this machine; every button reads it as `disabled`. */
    readonly working: ComputedRef<boolean>;
    readonly rowKey: (group: DeviceSandboxGroup) => string;
    // Three keys per environment, not one: the switches, the agent and the enrollment each report where they
    // were pressed, and a single key would print one op's answer under another's controls.
    readonly switchKey: (environment: DeviceRow) => string;
    readonly agentKey: (environment: DeviceRow) => string;
    readonly accessKey: (environment: DeviceRow) => string;
    readonly failure: Ref<{ key: string; notice: NoticeModel } | undefined>;
    readonly outcome: Ref<{ key: string; message: string } | undefined>;

    // Container verbs, through whichever door is open.
    readonly act: (group: DeviceSandboxGroup, verb: SandboxVerb) => void;
    readonly runningVerb: (group: DeviceSandboxGroup) => SandboxVerb | undefined;
    readonly verbRunning: (group: DeviceSandboxGroup) => boolean;
    readonly lines: (group: DeviceSandboxGroup) => readonly string[];
    readonly logShown: (group: DeviceSandboxGroup) => boolean;
    readonly confirmingAct: Ref<{ group: DeviceSandboxGroup; verb: SandboxVerb } | undefined>;
    readonly actPrompt: ComputedRef<ActPrompt | undefined>;
    readonly confirmAct: () => void;
    readonly reshaping: Ref<{ group: DeviceSandboxGroup } | undefined>;
    readonly applyReshape: (ask: ResourcesAsk) => void;
    readonly selfGroup: (group: DeviceSandboxGroup) => boolean;

    // Everything one machine's file sync can be told to do: the switches over a pairing, and the one that starts
    // one. `folder` rides only the latter, and is what picks the environment that ends up running mutagen.
    readonly runSync: (
        environment: DeviceRow,
        key: string,
        sandboxId: string | undefined,
        command: SyncCommand,
        folder?: { readonly mode: "sync" | "mirror"; readonly localDir?: string },
    ) => Promise<void>;
    readonly syncRunning: (key: string, command: SyncCommand) => boolean;
    readonly confirmingUnpair: Ref<{ environment: DeviceRow; group: DeviceSandboxGroup } | undefined>;
    readonly confirmUnpair: () => void;

    // One environment's agent and its two ops.
    readonly runAgent: (environment: DeviceRow, op: DeviceAgentOp) => Promise<void>;
    /** Which of this environment's ops is in flight; a row has one thing to say. */
    readonly agentOp: (environment: DeviceRow) => DeviceAgentOp | undefined;
    readonly agentBusy: (environment: DeviceRow) => boolean;
    readonly agentLines: (environment: DeviceRow) => readonly string[];
    readonly agentWaiting: (environment: DeviceRow) => string | undefined;

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

    // Everything below runs on somebody else's machine and takes as long as it takes; the hub row keeps saying so
    // after this page is gone, since a container update is exactly the moment to go and read something else.
    const hubWork = useHubWork();

    const switchKey = (environment: DeviceRow): string => `${environment.device.key}:switches`;
    const agentKey = (environment: DeviceRow): string => `${environment.device.key}:agent`;
    const accessKey = (environment: DeviceRow): string => `${environment.device.key}:access`;
    const rowKey = (group: DeviceSandboxGroup): string => `${machine().key}:${group.sandboxId}`;
    const selfGroup = (group: DeviceSandboxGroup): boolean => isSelfMachine(machine(), group, ownSlug.value);
    // Whether this verb on this row takes down the connection the page is watching it through: what the dialog warns
    // about beforehand, and what makes a dead stream the answer rather than a failure afterwards.
    const severs = (group: DeviceSandboxGroup, verb: SandboxVerb): boolean => selfGroup(group) && SEVERING.has(OP[verb]);

    // `${rowKey}:${verb}`, so one string says both which row is working and at what.
    const busy = ref<string | undefined>();
    // Kept out of `busy`, which also drives which container-verb button spins; keyed by row and command,
    // since three buttons on a row must not spin together.
    const syncBusy = ref<{ key: string; command: SyncCommand } | undefined>();
    // The agent op in flight and whose agent it is, so the log lands under that environment's row.
    const agentOp = ref<{ key: string; op: DeviceAgentOp } | undefined>();
    const revoking = ref(false);
    const working = computed(() => busy.value !== undefined || syncBusy.value !== undefined || agentOp.value !== undefined || revoking.value);

    const failure = ref<{ key: string; notice: NoticeModel } | undefined>();
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

    const confirmingAct = ref<{ group: DeviceSandboxGroup; verb: SandboxVerb } | undefined>();
    const reshaping = ref<{ group: DeviceSandboxGroup } | undefined>();
    const confirmingUnpair = ref<{ environment: DeviceRow; group: DeviceSandboxGroup } | undefined>();
    const confirmingRevoke = ref<DeviceRow | undefined>();

    const actPrompt = computed<ActPrompt | undefined>(() => {
        const pending = confirmingAct.value;
        if (pending === undefined) {
            return undefined;
        }
        const asked = sandboxVerbPrompt(pending.verb, pending.group.title);
        // `logs` never confirms, so indexing the label past it is safe.
        const label = VERB_LABEL[pending.verb as Exclude<SandboxVerb, `logs`>];
        return {
            // A verb with no prompt of its own only reaches here by severing, so the fallback still asks a
            // real question.
            header: asked?.header ?? `${label} ${pending.group.title}?`,
            body: asked?.body,
            severing: severs(pending.group, pending.verb),
            label,
            destructive: pending.verb === `remove`,
        };
    });

    // The door container verbs travel through; undefined when no environment holds a socket.
    const door = (): string | undefined => managerOf(machine())?.device.hostId;

    // `resources` is the one verb with something to say beyond its name: the form's answer, forwarded unread.
    const runAct = async (group: DeviceSandboxGroup, verb: SandboxVerb, resources?: ResourcesAsk): Promise<void> => {
        const hostId = door();
        const slug = group.sandbox?.slug;
        if (hostId === undefined || slug === undefined || working.value) {
            return;
        }
        const key = rowKey(group);
        busy.value = `${key}:${verb}`;
        failure.value = undefined;
        outcome.value = undefined;
        runLines.value = { ...runLines.value, [key]: [] };
        // Opened before lines arrive, so an empty pane reads as "reading" rather than an ignored click.
        openLog.value = verb === `logs` ? key : undefined;
        const endMark = markVerb(hubWork, group, verb);
        try {
            const message = await manageDeviceSandbox(hostId, slug, OP[verb], {
                resources,
                onLine: (line) => (runLines.value = { ...runLines.value, [key]: [...(runLines.value[key] ?? []), line] }),
                // The same severing the dialog warned about: losing the stream is the answer, not a failure to report.
                severing: severs(group, verb),
            });
            // A log tail's result line would only restate the pane above it, so it's left to be the answer.
            outcome.value = verb === `logs` ? undefined : { key, message };
        } catch (error) {
            failure.value = { key, notice: noticeFrom(error, `That didn't work on this device.`) };
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
                    title: `That device didn't report this sandbox's share of it.`,
                    // Names the button on this very page, not a command: the agent flow does the upgrade from here.
                    detail: `Refresh and try again. If it keeps happening, its agent is too old to report a share — Update agent, above, fixes that from here.`,
                },
            };
            return;
        }
        reshaping.value = { group };
    };

    const act = (group: DeviceSandboxGroup, verb: SandboxVerb): void => {
        if (door() === undefined || group.sandbox === undefined || working.value) {
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
        if (sandboxVerbPrompt(verb, group.title) !== undefined || severs(group, verb)) {
            confirmingAct.value = { group, verb };
            return;
        }
        void runAct(group, verb);
    };

    const confirmAct = (): void => {
        const pending = confirmingAct.value;
        confirmingAct.value = undefined;
        if (pending !== undefined) {
            void runAct(pending.group, pending.verb);
        }
    };

    const applyReshape = (ask: ResourcesAsk): void => {
        const pending = reshaping.value;
        reshaping.value = undefined;
        if (pending !== undefined) {
            void runAct(pending.group, `resources`, ask);
        }
    };

    // No confirmation for the reversible four; `sync-unpair` alone routes through the dialog. `sandboxId`
    // present targets one pairing, absent runs the bare machine-wide CLI form. The environment named here is the door
    // the line is SENT to; which environment ends up running it is the daemon's call, made from the folder
    // (hosts/device-commands.ts) — mutagen can only watch the filesystem that holds it.
    const runSync = async (
        environment: DeviceRow,
        key: string,
        sandboxId: string | undefined,
        command: SyncCommand,
        folder?: { readonly mode: "sync" | "mirror"; readonly localDir?: string },
    ): Promise<void> => {
        const hostId = environment.device.hostId;
        if (hostId === undefined || working.value) {
            return;
        }
        syncBusy.value = { key, command };
        failure.value = undefined;
        outcome.value = undefined;
        const endMark = hubWork.begin(`${SYNC_WORKING[command]} on ${environment.device.label}`);
        try {
            const result = await runDeviceCommand(hostId, command, { sandboxId, ...folder });
            // The machine's own sentence either way: a refusal names the switch to flip rather than throwing.
            outcome.value = result.ok ? { key, message: result.message } : undefined;
            failure.value = result.ok ? undefined : { key, notice: { tone: `warning`, title: COMMAND_REFUSAL[command], detail: result.message } };
        } catch (error) {
            failure.value = { key, notice: noticeFrom(error, COMMAND_UNREACHED[command]) };
        } finally {
            syncBusy.value = undefined;
            endMark();
            // Blocks on a fresh read rather than serving the pre-click list, since the daemon dropped its
            // cached reading as the command ran.
            refetch();
        }
    };

    const syncRunning = (key: string, command: SyncCommand): boolean =>
        syncBusy.value?.key === key && (syncBusy.value.command === command || syncBusy.value.command === PAIRED_WITH[command]);

    // Unpairing doesn't undo itself (a fresh one-liner re-enrolls), so it parks in the app's own dialog like
    // the container verbs.
    const confirmUnpair = (): void => {
        const pending = confirmingUnpair.value;
        confirmingUnpair.value = undefined;
        if (pending !== undefined) {
            void runSync(pending.environment, rowKey(pending.group), pending.group.sandboxId, `sync-unpair`);
        }
    };

    // Whether an environment's agent is between "we asked" and "its version moved"; survives the call ending,
    // since the call ending is not the answer. Keyed by agent, so the note lands under the row that was pressed.
    const waiting = ref<{ key: string; text: string } | undefined>();
    const agentLog = ref<{ key: string; lines: string[] } | undefined>();

    const runAgent = async (environment: DeviceRow, op: DeviceAgentOp): Promise<void> => {
        const hostId = environment.device.hostId;
        if (hostId === undefined || working.value) {
            return;
        }
        const key = agentKey(environment);
        agentOp.value = { key, op };
        failure.value = undefined;
        outcome.value = undefined;
        agentLog.value = { key, lines: [] };
        waiting.value = { key, text: AGENT_ASKED[op] };
        const endMark = hubWork.begin(AGENT_WORKING[op]);
        try {
            const { message } = await runDeviceAgentFlow(hostId, op, {
                onLine: (line) => (agentLog.value = { key, lines: [...(agentLog.value?.lines ?? []), line] }),
            });
            // Only the device's own sentence, and only if it managed to send one; no fallback text.
            outcome.value = message === undefined ? undefined : { key, message };
        } catch (error) {
            // A refusal, not a lost connection: the client only throws for a frame the device actually sent.
            // The waiting note is dropped, since nothing is on its way back.
            failure.value = { key, notice: noticeFrom(error, `That device wouldn't update its agent.`) };
            waiting.value = undefined;
        } finally {
            agentOp.value = undefined;
            endMark();
            // The version is the answer, so ask for it; the tab's own poll picks it up as the loop comes back.
            refetch();
        }
    };

    // The environment whose agent is being waited on, by the key the note was filed under.
    const waitedOn = (): DeviceRow | undefined => machine().environments.find((environment) => agentKey(environment) === waiting.value?.key);

    // Clears once the fact it was waiting for arrives (a live, unstalled, current loop); watched rather than
    // computed so it survives a poll landing mid-restart.
    watch(
        () => {
            const current = waitedOn();
            return `${current?.agent?.build ?? ``}:${current?.chip?.installed ?? ``}:${current?.chip?.available ?? ``}`;
        },
        () => {
            const current = waitedOn();
            const settled =
                current?.agent?.running === true &&
                current.agent.stalled === false &&
                current.agent.staleBuild === undefined &&
                current.chip?.available === undefined;
            if (settled) {
                waiting.value = undefined;
            }
        },
    );

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
            outcome.value = { key, message: `${label} no longer has access to this sandbox.` };
        } catch (error) {
            failure.value = { key, notice: noticeFrom(error, `Couldn't revoke that device's access.`) };
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
        agentKey,
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
        selfGroup,
        runSync,
        syncRunning,
        confirmingUnpair,
        confirmUnpair,
        runAgent,
        agentOp: (environment) => (agentOp.value?.key === agentKey(environment) ? agentOp.value.op : undefined),
        agentBusy: (environment) => agentOp.value?.key === agentKey(environment),
        agentLines: (environment) => (agentLog.value?.key === agentKey(environment) ? agentLog.value.lines : []),
        agentWaiting: (environment) => (waiting.value?.key === agentKey(environment) ? waiting.value.text : undefined),
        confirmingRevoke,
        revoking,
        runRevoke,
    };
}
