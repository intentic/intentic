import type { DeviceAgentOp, DeviceCommand, DeviceSandboxOp } from "@intentic/sandbox-contract";
import type { DeviceSandboxGroup, NoticeModel, ResourcesAsk, SandboxVerb } from "@intentic/ui";
import { sandboxVerbPrompt, VERB_LABEL } from "@intentic/ui";
import { noticeFrom } from "@intentic/ui/async";
import { computed, type ComputedRef, type Ref, ref, watch } from "vue";
import { type DeviceRow, isSelf } from "./deviceRows";
import { manageDeviceSandbox, revokeSyncDevice, runDeviceAgentFlow, runDeviceCommand } from "./useDevices";
import { useSandbox } from "../client/useSandbox";

// Everything one device page does TO its machine: the container verbs, the two sync switches, the agent's
// own two ops, and revoking the enrollment. One op at a time per machine, since a mirroring switch racing a
// container verb on the same pairing would be two answers about the same ports.

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

// Pause/resume and mirror on/off are one button wearing two labels; the label flips on the next report, not
// the click, so a spinner must answer to either direction.
const PAIRED_WITH: Partial<Record<DeviceCommand, DeviceCommand>> = {
    "sync-pause": `sync-resume`,
    "sync-resume": `sync-pause`,
    "mirror-off": `mirror-on`,
    "mirror-on": `mirror-off`,
};

// Kept beside each other rather than inlined at each call site, so a verb and its failure sentence can't
// drift apart.
const COMMAND_REFUSAL: Record<DeviceCommand, string> = {
    "mirror-off": `That device didn't change its port mirroring.`,
    "mirror-on": `That device didn't change its port mirroring.`,
    "sync-pause": `That device didn't pause its file syncing.`,
    "sync-resume": `That device didn't resume its file syncing.`,
    "sync-unpair": `That device didn't unpair this sandbox.`,
};

const COMMAND_UNREACHED: Record<DeviceCommand, string> = {
    "mirror-off": `Couldn't reach that device to change its port mirroring.`,
    "mirror-on": `Couldn't reach that device to change its port mirroring.`,
    "sync-pause": `Couldn't reach that device to pause its file syncing.`,
    "sync-resume": `Couldn't reach that device to resume its file syncing.`,
    "sync-unpair": `Couldn't reach that device to unpair this sandbox.`,
};

// Update and restart both stop the resident process carrying the request, so the page can't claim an
// outcome: it shows what was watched, then this, and the confirmation is the next poll's version.
const AGENT_ASKED: Record<DeviceAgentOp, string> = {
    upgrade: `Updating its agent. The connection to this device drops while its loop restarts — this page shows the new version when it comes back.`,
    restart: `Restarting its agent. The connection to this device drops while that happens.`,
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
    // Three keys, not one: the switches, the agent and the enrollment each report where they were pressed,
    // and a single machine key would print one op's answer under another's controls.
    readonly machineKey: ComputedRef<string>;
    readonly agentKey: ComputedRef<string>;
    readonly accessKey: ComputedRef<string>;
    readonly failure: Ref<{ key: string; notice: NoticeModel } | undefined>;
    readonly outcome: Ref<{ key: string; message: string } | undefined>;

    // Container verbs.
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

    // The two sync switches, per pairing and machine-wide.
    readonly runSync: (key: string, sandboxId: string | undefined, command: DeviceCommand) => Promise<void>;
    readonly syncRunning: (key: string, command: DeviceCommand) => boolean;
    readonly confirmingUnpair: Ref<{ group: DeviceSandboxGroup } | undefined>;
    readonly confirmUnpair: () => void;

    // The agent's own two ops.
    readonly runAgent: (op: DeviceAgentOp) => Promise<void>;
    readonly agentRunning: (op: DeviceAgentOp) => boolean;
    readonly agentBusy: ComputedRef<boolean>;
    readonly agentLines: ComputedRef<readonly string[]>;
    readonly agentWaiting: ComputedRef<string | undefined>;

    // Cutting the machine off entirely.
    readonly confirmingRevoke: Ref<boolean>;
    readonly revoking: Ref<boolean>;
    readonly runRevoke: () => Promise<void>;
}

export function useDeviceOps(row: () => DeviceRow, refetch: () => void): DeviceOps {
    // The sandbox serving this page, by its container slug on the machine: the daemon's own hostname, same
    // derivation the switcher and setup CLI use.
    const { daemonUrl } = useSandbox();
    const ownSlug = computed(() => (daemonUrl.value === undefined ? undefined : new URL(daemonUrl.value).hostname.split(`.`)[0]));

    const device = computed(() => row().device);
    const machineKey = computed(() => device.value.key);
    const agentKey = computed(() => `${device.value.key}:agent`);
    const accessKey = computed(() => `${device.value.key}:access`);
    const rowKey = (group: DeviceSandboxGroup): string => `${device.value.key}:${group.sandboxId}`;
    const selfGroup = (group: DeviceSandboxGroup): boolean => isSelf(device.value, group, ownSlug.value);

    // `${rowKey}:${verb}`, so one string says both which row is working and at what.
    const busy = ref<string | undefined>();
    // Kept out of `busy`, which also drives which container-verb button spins; keyed by row and command,
    // since three buttons on a row must not spin together.
    const syncBusy = ref<{ key: string; command: DeviceCommand } | undefined>();
    const agentOp = ref<DeviceAgentOp | undefined>();
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
    const confirmingUnpair = ref<{ group: DeviceSandboxGroup } | undefined>();
    const confirmingRevoke = ref(false);

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
            severing: selfGroup(pending.group) && SEVERING.has(OP[pending.verb]),
            label,
            destructive: pending.verb === `remove`,
        };
    });

    // `resources` is the one verb with something to say beyond its name: the form's answer, forwarded unread.
    const runAct = async (group: DeviceSandboxGroup, verb: SandboxVerb, resources?: ResourcesAsk): Promise<void> => {
        const hostId = device.value.hostId;
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
        try {
            const message = await manageDeviceSandbox(hostId, slug, OP[verb], {
                resources,
                onLine: (line) => (runLines.value = { ...runLines.value, [key]: [...(runLines.value[key] ?? []), line] }),
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
                    detail: `Refresh and try again. If it keeps happening, run intentic-machine upgrade on that computer: its agent is too old to say.`,
                },
            };
            return;
        }
        reshaping.value = { group };
    };

    const act = (group: DeviceSandboxGroup, verb: SandboxVerb): void => {
        if (device.value.hostId === undefined || group.sandbox === undefined || working.value) {
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
        if (sandboxVerbPrompt(verb, group.title) !== undefined || (selfGroup(group) && SEVERING.has(OP[verb]))) {
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
    // present targets one pairing, absent runs the bare machine-wide CLI form.
    const runSync = async (key: string, sandboxId: string | undefined, command: DeviceCommand): Promise<void> => {
        const hostId = device.value.hostId;
        if (hostId === undefined || working.value) {
            return;
        }
        syncBusy.value = { key, command };
        failure.value = undefined;
        outcome.value = undefined;
        try {
            const result = await runDeviceCommand(hostId, command, sandboxId);
            // The machine's own sentence either way: a refusal names the switch to flip rather than throwing.
            outcome.value = result.ok ? { key, message: result.message } : undefined;
            failure.value = result.ok ? undefined : { key, notice: { tone: `warning`, title: COMMAND_REFUSAL[command], detail: result.message } };
        } catch (error) {
            failure.value = { key, notice: noticeFrom(error, COMMAND_UNREACHED[command]) };
        } finally {
            syncBusy.value = undefined;
            // Blocks on a fresh read rather than serving the pre-click list, since the daemon dropped its
            // cached reading as the command ran.
            refetch();
        }
    };

    const syncRunning = (key: string, command: DeviceCommand): boolean =>
        syncBusy.value?.key === key && (syncBusy.value.command === command || syncBusy.value.command === PAIRED_WITH[command]);

    // Unpairing doesn't undo itself (a fresh one-liner re-enrolls), so it parks in the app's own dialog like
    // the container verbs.
    const confirmUnpair = (): void => {
        const pending = confirmingUnpair.value;
        confirmingUnpair.value = undefined;
        if (pending !== undefined) {
            void runSync(rowKey(pending.group), pending.group.sandboxId, `sync-unpair`);
        }
    };

    // Whether this device is between "we asked" and "its version moved"; survives the call ending, since
    // the call ending is not the answer.
    const waiting = ref<string | undefined>();
    const agentLog = ref<string[]>([]);

    const runAgent = async (op: DeviceAgentOp): Promise<void> => {
        const hostId = device.value.hostId;
        if (hostId === undefined || working.value) {
            return;
        }
        const key = agentKey.value;
        agentOp.value = op;
        failure.value = undefined;
        outcome.value = undefined;
        agentLog.value = [];
        waiting.value = AGENT_ASKED[op];
        try {
            const { message } = await runDeviceAgentFlow(hostId, op, { onLine: (line) => (agentLog.value = [...agentLog.value, line]) });
            // Only the device's own sentence, and only if it managed to send one; no fallback text.
            outcome.value = message === undefined ? undefined : { key, message };
        } catch (error) {
            // A refusal, not a lost connection: the client only throws for a frame the device actually sent.
            // The waiting note is dropped, since nothing is on its way back.
            failure.value = { key, notice: noticeFrom(error, `That device wouldn't update its agent.`) };
            waiting.value = undefined;
        } finally {
            agentOp.value = undefined;
            // The version is the answer, so ask for it; the tab's own poll picks it up as the loop comes back.
            refetch();
        }
    };

    // Clears once the fact it was waiting for arrives (a live, unstalled, current loop); watched rather than
    // computed so it survives a poll landing mid-restart.
    watch(
        () => {
            const current = row();
            return `${current.agent?.build ?? ``}:${current.chip?.installed ?? ``}:${current.chip?.available ?? ``}`;
        },
        () => {
            const current = row();
            const settled =
                current.agent?.running === true &&
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
        const enrollment = device.value.sync;
        // The enrollment may have vanished between opening the dialog and confirming it; nothing left to
        // revoke closes it quietly.
        if (enrollment === undefined) {
            confirmingRevoke.value = false;
            return;
        }
        const key = accessKey.value;
        const label = device.value.label;
        revoking.value = true;
        failure.value = undefined;
        outcome.value = undefined;
        try {
            await revokeSyncDevice(enrollment.machine);
            outcome.value = { key, message: `${label} no longer has access to this sandbox.` };
        } catch (error) {
            failure.value = { key, notice: noticeFrom(error, `Couldn't revoke that device's access.`) };
        } finally {
            confirmingRevoke.value = false;
            revoking.value = false;
            // The row is losing its enrollment either way, so refetch regardless of whether the call itself
            // succeeded.
            refetch();
        }
    };

    return {
        working,
        rowKey,
        machineKey,
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
        agentRunning: (op) => agentOp.value === op,
        agentBusy: computed(() => agentOp.value !== undefined),
        agentLines: computed(() => agentLog.value),
        agentWaiting: computed(() => waiting.value),
        confirmingRevoke,
        revoking,
        runRevoke,
    };
}
