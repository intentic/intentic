<script setup lang="ts">
import {
    type Device,
    type DeviceAgent,
    type DeviceAgentOp,
    type DeviceCommand,
    type DeviceSandboxOp,
    agentBuildSkew,
    agentStalled,
} from "@intentic/sandbox-contract";
import {
    Button,
    ConfirmDialog,
    DisclosureRow,
    groupNeedsAttention,
    InfoHint,
    DeviceDetail,
    type DeviceFolderRow,
    DeviceRunLog,
    type DeviceSandboxGroup,
    Icon,
    mirroringOff,
    Notice,
    type NoticeModel,
    type ResourcesAsk,
    RowGroup,
    RowNote,
    sandboxGroups,
    SandboxResourcesDialog,
    type SandboxVerb,
    sandboxVerbPrompt,
    SandboxVerbs,
    SearchBar,
    SkeletonRows,
    StatusBadge,
    StatusTally,
    type StatusVariant,
    type TallyItem,
    timeAgo,
    VERB_LABEL,
} from "@intentic/ui";
import { noticeFrom, useNow } from "@intentic/ui/async";
import { computed, onMounted, ref, watch } from "vue";
import DeviceRunners from "./DeviceRunners.vue";
import { type RouteLocationRaw, RouterLink, useRoute } from "vue-router";
import ControlTokensSection from "../access/ControlTokensSection.vue";
import {
    type AgentChip,
    agentBehind,
    agentChip,
    type DeviceScopes,
    deviceDoors,
    deviceSummary,
    lastSeenNote,
    deviceHardware,
    type ManageBlock,
    manageBlock,
    osLabel,
    osTitle,
    syncNote,
    syncStopped,
} from "./deviceFacts";
import DesktopSyncCard from "./DesktopSyncCard.vue";
import { type ConflictAsk, conflictAsk } from "./conflictAsk";
import { startAgent } from "../../agents/fleet/agentActions";
import { useCapabilities } from "../../capabilities/connect/useCapabilities";
import { manageDeviceSandbox, reportStale, revokeSyncDevice, runDeviceAgentFlow, runDeviceCommand, useDevices } from "./useDevices";
import { useRole } from "../secrets/useRole";
import { useSandbox } from "../client/useSandbox";
import { useSandboxOutline } from "../overview/useSandboxOutline";
import { useSandboxVersion } from "../overview/useSandboxVersion";
import { desktopApp } from "../../../app/environments/desktop";

// The Sandbox hub's Devices tab: what is on the other end of this sandbox. Desktop sync is a property of each
// device, not of the sandbox, so every device gets one row with its own folder, ports, containers and
// switches; <DeviceDetail> draws the container half, this file the device half.

const route = useRoute();
const highlight = ref(false);
const { devices, error, isLoading, refetch } = useDevices();
// Before the list lands, "no device is paired" would be a guess; the outline holds the row's shape instead,
// for the first read only.
const outline = useSandboxOutline(isLoading);
// The list query's bare error, in the words of the page that asked for it.
const computersNotice = computed<NoticeModel | undefined>(() =>
    error.value === undefined ? undefined : { tone: `danger`, title: `Couldn't list your devices.`, detail: error.value },
);

// One quantised clock for the whole render: every derivation here hangs off it, and rounding to the poll
// interval (10s) stops the cascade from re-deriving every second for data that arrives every ten.
const CLOCK_STEP_MS = 10_000;
const ticking = useNow();
const now = computed(() => Math.floor(ticking.value / CLOCK_STEP_MS) * CLOCK_STEP_MS);

// The release this sandbox knows about, from the shared /info query (same value as its own update badge);
// undefined on a sandbox that hasn't reached the registry, or a dev build.
const { latest } = useSandboxVersion();
onMounted(() => {
    if (route.query[`enable`] === `desktop-sync`) {
        highlight.value = true;
        setTimeout(() => document.getElementById(`desktop-sync`)?.scrollIntoView({ behavior: `smooth`, block: `center` }), 50);
    }
});

// Each gap is a different errand and gets its own sentence; `scope-off` names the switch to flip, since that's
// the only one closed in a single click.
const GAP_TEXT: Record<NonNullable<Device[`gap`]>, string> = {
    offline: `Asleep or offline.`,
    "scope-off": `Turn on "Run commands" in this device's capability card to see what it is running.`,
    "no-agent": `Reachable, but it has no agent, so nothing here knows its folders or ports.`,
    unreported: `Enrolled, but it hasn't reported yet. An agent from before machine reports never will. Re-run its install to update it.`,
};

// This tab's three text sizes: 14px names an entry, 12px is anything read (path, port, sentence, verb), 11px
// is for labels and ids that only need to be findable.
const SUBHEAD = `text-2xs font-semibold uppercase tracking-wide text-subtle`;

// One tag per door this sandbox reaches the device through, tinted rather than outlined.
const DOOR = `inline-flex items-center gap-1.5 rounded-md bg-content/5 px-2 py-0.5 text-2xs text-muted`;

// Whether the agent is up but no longer making rounds, the same rule the terminal uses (agentStalled).
const agentHalted = (device: Device): boolean => device.report !== undefined && agentStalled(device.report.agent, now.value);

const tone = (device: Device): StatusVariant => {
    if (device.gap !== undefined) {
        return device.gap === `offline` ? `neutral` : `warning`;
    }
    // A stalled agent is the same errand as a stopped one: nothing is reaching that device's ports or clones.
    if (reportStale(device, now.value) || device.report?.agent.running === false || agentHalted(device)) {
        return `warning`;
    }
    return `success`;
};

// The badge's word must agree with its colour: a dead sync agent is amber, so it reads "needs attention"
// rather than "live".
const label = (device: Device): string => {
    if (device.gap !== undefined) {
        return device.gap === `offline` ? `offline` : `needs attention`;
    }
    if (reportStale(device, now.value)) {
        return `gone quiet`;
    }
    return device.report?.agent.running === false || agentHalted(device) ? `needs attention` : `live`;
};

// Machines worth reading first: state leads, name breaks ties, so order only changes when a machine's state
// does. Live ranks above needs-attention, since a live row is the point of the page.
const RANK: Record<string, number> = { live: 0, "needs attention": 1, "gone quiet": 2, offline: 3 };

const sorted = computed(() => devices.value.toSorted((a, b) => (RANK[label(a)] ?? 9) - (RANK[label(b)] ?? 9) || a.label.localeCompare(b.label)));

// One row per device, its sandbox groups derived once here rather than per template read, since the same
// grouping backs every count and warning on the folded line.
const deviceGroups = (device: Device): DeviceSandboxGroup[] =>
    device.report === undefined ? [] : sandboxGroups(device.report.pairings, device.report.ports, device.report.sandboxes);

const has = (needle: string, ...fields: (string | undefined)[]): boolean =>
    fields.some((field) => field !== undefined && field.toLowerCase().includes(needle));

// Port numbers are matched too: "which machine has 8788" is the single most common reason to open this tab.
const groupMatches = (group: DeviceSandboxGroup, needle: string): boolean =>
    has(needle, group.title, group.subtitle, group.sandboxId, group.sandbox?.slug, group.sandbox?.image, group.folder?.localDir) ||
    group.ports.some((port) => String(port.port).includes(needle));

interface DeviceRow {
    readonly device: Device;
    readonly groups: readonly DeviceSandboxGroup[];
    /** The folded line's counts, uncoloured. */
    readonly facts: readonly string[];
    /** The folded line's reasons to open it. */
    readonly warnings: readonly string[];
    /** Sandbox ids this machine should unfold on arrival: the one in use, and anything the filter hit. */
    readonly open: readonly string[];
    // The device's agent with this render's verdicts already attached (stalled, staleBuild); absent on a device
    // that never reported. Derived here rather than in the template, where a fresh object every render would
    // thrash on facts that change about once a minute.
    readonly agent:
        | (DeviceAgent & { readonly stalled: boolean; readonly staleBuild?: { running: string | undefined; installed: string } })
        | undefined;
    /** What the header chip says about the agent: build serving, an owed restart, a published update. */
    readonly chip: AgentChip | undefined;
}

// The sandbox you're looking at, by its container slug on this machine: the daemon's own hostname, same
// derivation the switcher and setup CLI use.
const { daemonUrl } = useSandbox();
const ownSlug = computed(() => (daemonUrl.value === undefined ? undefined : new URL(daemonUrl.value).hostname.split(`.`)[0]));
// Both sides must be known: comparing two optionals let a pairing with no container on an unknown-URL sandbox
// match `undefined === undefined` and falsely claim to be the one in use.
const isSelf = (device: Device, group: DeviceSandboxGroup): boolean =>
    device.hostId !== undefined && ownSlug.value !== undefined && group.sandbox?.slug === ownSlug.value;

// Lower-cased once here rather than per comparison; blank until typed, so an empty filter never narrows anything.
const query = ref(``);
const needle = computed(() => query.value.trim().toLowerCase());

const rows = computed<DeviceRow[]>(() =>
    sorted.value.map((device) => {
        const groups = deviceGroups(device);
        const { facts, warnings } = deviceSummary(device, groups, now.value);
        const agent = device.report?.agent;
        // Whether this device serves an older agent than the one installed (agentBuildSkew); no report means no
        // comparison.
        const staleBuild = agent === undefined ? undefined : agentBuildSkew(agent);
        return {
            device,
            groups,
            facts,
            warnings,
            open: groups
                .filter((group) => isSelf(device, group) || (needle.value !== `` && groupMatches(group, needle.value)))
                .map((group) => group.sandboxId),
            agent:
                agent === undefined
                    ? undefined
                    : { ...agent, stalled: agentStalled(agent, now.value), ...(staleBuild === undefined ? {} : { staleBuild }) },
            chip: agentChip(device, latest.value),
        };
    }),
);

// The filter narrows machines and unfolds rows rather than hiding rows inside a machine, since a port's
// explanation names the sandbox that took it and filtering that sandbox away would cut the link.
const shown = computed<DeviceRow[]>(() => {
    const text = needle.value;
    if (text === ``) {
        return rows.value;
    }
    return rows.value.filter(
        (row) =>
            has(text, row.device.label, row.device.key, osLabel(row.device), row.device.hostId, row.device.report?.hostname) ||
            row.groups.some((group) => groupMatches(group, text)),
    );
});

// Shown only once there's enough to search: a filter over two rows costs more attention than it saves.
const FILTER_FLOOR = 3;
const showFilter = computed(() => rows.value.length > 2 || rows.value.reduce((total, row) => total + row.groups.length, 0) > FILTER_FLOOR);

// The orientation line, answered before a row is parsed: one measure (sandboxes) split by state; `running`
// stays visible even at zero so the tally never renders as nothing.
const tally = computed<TallyItem[]>(() => {
    const groups = rows.value.flatMap((row) => row.groups);
    return [
        { label: `running`, value: groups.filter((group) => group.sandbox?.running === true).length, variant: `success`, always: true },
        { label: `stopped`, value: groups.filter((group) => group.sandbox?.running === false).length, variant: `neutral` },
        { label: `need attention`, value: groups.filter(groupNeedsAttention).length, variant: `warning` },
    ];
});

// Which machines are unfolded: the one running the sandbox you're using, else the first with anything to show,
// plus anything the filter matched. Not every machine with a warning — the folded line already states it.
const openDevices = ref(new Set<string>());
const foldedDevices = ref(new Set<string>());
const expandable = (row: DeviceRow): boolean => row.device.report !== undefined;
const autoOpenDevice = computed(() => {
    const withReport = rows.value.filter(expandable);
    const self = withReport.find((row) => row.groups.some((group) => isSelf(row.device, group)));
    const matched = needle.value === `` ? [] : shown.value.filter(expandable).map((row) => row.device.key);
    return new Set([...(self === undefined ? withReport.slice(0, 1) : [self]).map((row) => row.device.key), ...matched]);
});
const deviceOpen = (row: DeviceRow): boolean =>
    expandable(row) &&
    (openDevices.value.has(row.device.key) || (autoOpenDevice.value.has(row.device.key) && !foldedDevices.value.has(row.device.key)));
const toggleDevice = (row: DeviceRow): void => {
    const key = row.device.key;
    const shutting = deviceOpen(row);
    openDevices.value = new Set([...openDevices.value].filter((seen) => seen !== key));
    foldedDevices.value = new Set([...foldedDevices.value].filter((seen) => seen !== key));
    const target = shutting ? foldedDevices : openDevices;
    target.value = new Set([...target.value, key]);
};
// A machine the filter newly matched reopens even if the reader folded it earlier.
watch(
    () => [...autoOpenDevice.value].join(`|`),
    (keys) => (foldedDevices.value = new Set([...foldedDevices.value].filter((key) => !keys.split(`|`).includes(key)))),
);

// Buttons show only where a click can work: the machine is a reachable connected device, and the row is a real
// container, not a bare pairing.
const manageable = (device: Device, group: DeviceSandboxGroup): boolean =>
    device.hostId !== undefined && device.online === true && group.sandbox !== undefined;

// Why a row has no buttons, said before anyone goes looking for them (deviceFacts.ts holds the rule): switches
// are read from the capability so a refusal is stated up front rather than discovered by a click.
const { capabilities } = useCapabilities();
const scopesOf = (device: Device): DeviceScopes | undefined =>
    device.hostId === undefined ? undefined : capabilities.value.find((capability) => capability.id === device.hostId)?.config;
// Derived once per list rather than once per template read of a row's block (asked four times each).
const blocks = computed(() => new Map(sorted.value.map((device) => [device.key, manageBlock(device, scopesOf(device))])));
const blockOf = (device: Device): ManageBlock | undefined => blocks.value.get(device.key);

// Each block is a different errand, so each gets its own sentence.
const BLOCK_TEXT: Record<ManageBlock[`kind`], string> = {
    connect: `Desktop sync carries folders and ports, never containers, so its sandboxes can't be started, updated or removed from here. Connect it as a device for the same buttons the desktop app's own window has.`,
    // Every button below needs this device's own outbound socket; a machine can sync files flawlessly with that
    // socket down.
    offline: `This device is connected but isn't reachable right now — asleep, off the network, or its agent isn't running — so its sandboxes can't be started, updated or removed from here.`,
    "sandboxes-off": `Turn on "Manage sandboxes on this device" in this device's capability card to use the buttons below.`,
    "remove-off": `Removing a sandbox needs "Remove sandboxes from this device" on this device's capability card. Everything else below already works.`,
};
// Set in mono like every other command this view names, rather than left as bare text inside a sentence.
const BLOCK_COMMAND: Partial<Record<ManageBlock[`kind`], string>> = { offline: `intentic-machine run` };
// Only the kinds a click can close; an offline device gets no button, since its fix is a command on that
// machine, not a capability card.
const BLOCK_ACTION: Partial<Record<ManageBlock[`kind`], string>> = {
    connect: `Connect this device`,
    "sandboxes-off": `Open its permissions`,
    "remove-off": `Open its permissions`,
};

// `connect` opens the card that adds a device; the other two open the existing connection's own form.
// Undefined when this build has no card for the platform.
const blockTarget = (block: ManageBlock | undefined): RouteLocationRaw | undefined => {
    if (block?.card === undefined) {
        return undefined;
    }
    const card = { name: `capabilities`, params: { card: block.card } };
    return block.kind === `connect` ? card : { ...card, query: { edit: block.connection } };
};

// Keyed off the row, since a template can't narrow across elements the way four call sites would need.
const blockText = (device: Device): string | undefined => {
    const block = blockOf(device);
    return block === undefined ? undefined : BLOCK_TEXT[block.kind];
};
// Undefined when there's nowhere to send anyone, so the sentence runs alone rather than beside a dead control.
const blockAction = (device: Device): string | undefined => {
    const block = blockOf(device);
    return block === undefined || blockTarget(block) === undefined ? undefined : BLOCK_ACTION[block.kind];
};
// The command to type on that device, where the fix is one rather than a click.
const blockCommand = (device: Device): string | undefined => {
    const block = blockOf(device);
    return block === undefined ? undefined : BLOCK_COMMAND[block.kind];
};
// Only read where blockAction already confirmed a destination; the fallback is unreachable.
const fixAt = (device: Device): RouteLocationRaw => blockTarget(blockOf(device)) ?? { name: `capabilities` };

// Read inside the desktop app, its own window needs no capability at all (it runs on the device it manages);
// said once, since no row here knows which machine the reader sits at.
const inDesktopApp = desktopApp() !== undefined;

const rowKey = (device: Device, group: DeviceSandboxGroup): string => `${device.key}:${group.sandboxId}`;
const busy = ref<string | undefined>();
// Pairing switches' busy state is kept out of `busy`, since `busy` also drives which container-verb button
// spins; keyed by row and command, since three buttons on a row must not spin together.
const syncBusy = ref<{ key: string; command: DeviceCommand } | undefined>();
// Pause/resume and mirror on/off are one button wearing two labels; the label flips on the next report, not
// the click.
const PAIRED_WITH: Partial<Record<DeviceCommand, DeviceCommand>> = {
    "sync-pause": `sync-resume`,
    "sync-resume": `sync-pause`,
    "mirror-off": `mirror-on`,
    "mirror-on": `mirror-off`,
};
const syncRunning = (device: Device, group: DeviceSandboxGroup, command: DeviceCommand): boolean =>
    syncBusy.value?.key === rowKey(device, group) && (syncBusy.value.command === command || syncBusy.value.command === PAIRED_WITH[command]);
// One op at a time across this whole tab: a mirroring switch racing a container verb on the same pairing would
// be two answers about the same ports. The agent flow counts too, since it takes the socket down.
const working = computed(() => busy.value !== undefined || syncBusy.value !== undefined || agentBusy.value !== undefined);
const actionError = ref<{ key: string; notice: NoticeModel } | undefined>();
const actionDone = ref<{ key: string; message: string } | undefined>();
// Keyed by row, so leaving one row's log on screen while reading another's is fine.
const runLines = ref<Record<string, string[]>>({});

// Which row's pane survives once nothing is running: `logs` is read after the op ends, unlike every other op
// whose lines were only progress.
const openLog = ref<string | undefined>();
const logShown = (device: Device, group: DeviceSandboxGroup): boolean => openLog.value === rowKey(device, group);

// Splits the row's own verb back out of the single-string `busy`, since only one op runs at a time.
const runningVerb = (device: Device, group: DeviceSandboxGroup): SandboxVerb | undefined => {
    const prefix = `${rowKey(device, group)}:`;
    return busy.value?.startsWith(prefix) === true ? (busy.value.slice(prefix.length) as SandboxVerb) : undefined;
};

// Which machine op each verb sends; only `resources` differs from its verb name (the kit's word for the form
// vs. the machine's word for what Apply does).
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

// Ops that end this browser's own connection when aimed at the sandbox serving it; `resources` carries its own
// warning instead.
const SEVERING = new Set<DeviceSandboxOp>([`stop`, `restart`, `update`, `rebuild`, `rollback`, `remove`]);

// The pending click, parked here until the app's own dialog answers (not the browser's confirm()); everything
// the dialog says derives from it.
const confirmingAct = ref<{ device: Device; group: DeviceSandboxGroup; op: SandboxVerb } | undefined>();
const actPrompt = computed(() => {
    const pending = confirmingAct.value;
    if (pending === undefined) {
        return undefined;
    }
    const asked = sandboxVerbPrompt(pending.op, pending.group.title);
    return {
        // A verb with no prompt of its own only reaches here by severing, so the fallback still asks a real question.
        header: asked?.header ?? `${VERB_LABEL[pending.op as Exclude<SandboxVerb, `logs`>]} ${pending.group.title}?`,
        body: asked?.body,
        // Rides the confirmation rather than replacing it: a destructive warning and a self-severing warning are two
        // different facts.
        severing: isSelf(pending.device, pending.group) && SEVERING.has(OP[pending.op]),
        // `logs` never confirms, so indexing the label past it is safe.
        label: VERB_LABEL[pending.op as Exclude<SandboxVerb, `logs`>],
        destructive: pending.op === `remove`,
    };
});
const confirmAct = (): void => {
    const pending = confirmingAct.value;
    confirmingAct.value = undefined;
    if (pending !== undefined) {
        void runAct(pending.device, pending.group, pending.op);
    }
};

// The resources form, parked on the row it's about until Apply or Cancel answers; only what changed travels
// down as the `reshape` op's payload.
const reshaping = ref<{ device: Device; group: DeviceSandboxGroup } | undefined>();
const applyReshape = (ask: ResourcesAsk): void => {
    const pending = reshaping.value;
    reshaping.value = undefined;
    if (pending !== undefined) {
        void runAct(pending.device, pending.group, `resources`, ask);
    }
};
// A row whose share wasn't reported has nothing to open the form on.
const openResources = (device: Device, group: DeviceSandboxGroup): void => {
    if (group.sandbox?.resources === undefined) {
        actionError.value = {
            key: rowKey(device, group),
            notice: {
                tone: `warning`,
                title: `That device didn't report this sandbox's share of it.`,
                detail: `Refresh and try again. If it keeps happening, run intentic-machine upgrade on that computer: its agent is too old to say.`,
            },
        };
        return;
    }
    reshaping.value = { device, group };
};

const act = (device: Device, group: DeviceSandboxGroup, op: SandboxVerb): void => {
    if (device.hostId === undefined || group.sandbox === undefined || working.value) {
        return;
    }
    if (op === `resources`) {
        openResources(device, group);
        return;
    }
    // The log button toggles: reopening what you closed is the same click, not a second control.
    if (op === `logs` && openLog.value === rowKey(device, group)) {
        openLog.value = undefined;
        // Cleared with the pane it described, so no result line floats under a row with nothing near it.
        actionDone.value = undefined;
        return;
    }
    if (sandboxVerbPrompt(op, group.title) !== undefined || (isSelf(device, group) && SEVERING.has(OP[op]))) {
        confirmingAct.value = { device, group, op };
        return;
    }
    void runAct(device, group, op);
};

// `resources` is the one verb with something to say beyond its name: the form's answer, forwarded unread.
const runAct = async (device: Device, group: DeviceSandboxGroup, op: SandboxVerb, resources?: ResourcesAsk): Promise<void> => {
    if (device.hostId === undefined || group.sandbox === undefined || working.value) {
        return;
    }
    const key = rowKey(device, group);
    const slug = group.sandbox.slug;
    busy.value = `${key}:${op}`;
    actionError.value = undefined;
    actionDone.value = undefined;
    runLines.value = { ...runLines.value, [key]: [] };
    // Opened before lines arrive, so an empty pane reads as "reading" rather than an ignored click.
    openLog.value = op === `logs` ? key : undefined;
    try {
        const message = await manageDeviceSandbox(device.hostId, slug, OP[op], {
            resources,
            onLine: (line) => (runLines.value = { ...runLines.value, [key]: [...(runLines.value[key] ?? []), line] }),
        });
        // A log tail's result line would only restate the pane above it, so it's left to be the answer.
        actionDone.value = op === `logs` ? undefined : { key, message };
    } catch (failure) {
        actionError.value = { key, notice: noticeFrom(failure, `That didn't work on this device.`) };
        if (op === `logs`) {
            openLog.value = undefined;
        }
    } finally {
        busy.value = undefined;
        // Always, including after failure: a flow that stopped halfway still changed the machine, so the row must
        // reflect what's there now.
        if (op !== `logs`) {
            refetch();
        }
    }
};

// What this device is doing for this sandbox, and how to change it: file syncing (pause/resume), port
// mirroring (off/on), and unpairing, which ends both. The machine owns all three; buttons run its own CLI over
// the device connection.
const commandable = (device: Device, group: DeviceSandboxGroup): boolean =>
    device.hostId !== undefined && device.online === true && device.gap === undefined && group.folder !== undefined;

// Offered only where there's a file sync to pause; a mirror-only enrollment has no session for it.
const pausable = (device: Device, group: DeviceSandboxGroup): boolean => commandable(device, group) && group.folder?.mode === `sync`;

// A conflict has no switch: choosing between two edited copies is judgement per file, so the control is a turn
// an agent can run against both ends, not a one-click winner.
const fixable = (device: Device, group: DeviceSandboxGroup): boolean => commandable(device, group) && (group.folder?.conflicts ?? 0) > 0;

const conflictTurn = (device: Device, group: DeviceSandboxGroup): ConflictAsk =>
    conflictAsk({
        machine: device.label,
        // Guarded by `fixable`, which already requires this device to have a host id.
        hostId: device.hostId ?? ``,
        localDir: group.folder?.localDir,
        conflicts: group.folder?.conflicts ?? 0,
        conflictedPaths: group.folder?.conflictedPaths ?? [],
    });

// Kept beside each other rather than inlined at each call site, so a verb and its failure sentence can't drift
// apart.
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

// No confirmation for the reversible four; `sync-unpair` alone routes through the dialog. `sandboxId` present
// targets one pairing, absent runs the bare machine-wide CLI form.
const runSync = async (device: Device, key: string, sandboxId: string | undefined, command: DeviceCommand): Promise<void> => {
    if (device.hostId === undefined || working.value) {
        return;
    }
    syncBusy.value = { key, command };
    actionError.value = undefined;
    actionDone.value = undefined;
    try {
        const result = await runDeviceCommand(device.hostId, command, sandboxId);
        // The machine's own sentence either way: a refusal names the switch to flip rather than throwing.
        actionDone.value = result.ok ? { key, message: result.message } : undefined;
        actionError.value = result.ok ? undefined : { key, notice: { tone: `warning`, title: COMMAND_REFUSAL[command], detail: result.message } };
    } catch (failure) {
        actionError.value = { key, notice: noticeFrom(failure, COMMAND_UNREACHED[command]) };
    } finally {
        syncBusy.value = undefined;
        // Blocks on a fresh read rather than serving the pre-click list, since the daemon dropped its cached reading
        // as the command ran.
        refetch();
    }
};

// The same two commands as the per-pairing buttons, run bare (no `--sandbox`), acting on every sandbox the
// device pairs — the answer to "I'm working on something else on this laptop".
type HalfState = `on` | `off` | `mixed`;
interface DeviceHalf {
    readonly state: HalfState;
    /** How many of this machine's pairings are in the minority, for the sentence that explains a mixed row. */
    readonly off: number;
    readonly total: number;
}

// Absent `mirroring` reads as on, matching every agent older than the switch.
const halfOf = (pairings: readonly (DeviceFolderRow | undefined)[], isOff: (folder: DeviceFolderRow) => boolean): DeviceHalf => {
    const held = pairings.filter((folder): folder is DeviceFolderRow => folder !== undefined);
    const off = held.filter((folder) => isOff(folder)).length;
    const state: HalfState = off === 0 ? `on` : off === held.length ? `off` : `mixed`;
    return { state, off, total: held.length };
};

// Counted only over sync pairings; a machine holding only mirrors draws no file-sync switch at all.
const syncHalf = (row: DeviceRow): DeviceHalf =>
    halfOf(
        row.groups.map((group) => group.folder).filter((folder) => folder?.mode === `sync`),
        (folder) => folder.paused === true,
    );
const mirrorHalf = (row: DeviceRow): DeviceHalf => halfOf(
    row.groups.map((group) => group.folder),
    mirroringOff,
);

// Offered under the same three conditions as the per-pairing buttons, plus more than one pairing for that
// half: over a single pairing this would be that row's own button wearing a wider, scarier label.
const switchable = (row: DeviceRow, half: DeviceHalf): boolean =>
    row.device.hostId !== undefined && row.device.online === true && row.device.gap === undefined && half.total > 1;

// The machine's own busy key; distinct from any `rowKey`, so the two scopes' spinners never collide.
const deviceKey = (device: Device): string => device.key;

// What a mixed half says, in the machine's own units ("2 of 3 paused").
const halfNote = (half: DeviceHalf, offWord: string): string | undefined =>
    half.state === `mixed` ? `${half.off} of ${half.total} ${offWord}` : undefined;

// Both halves are the same shape (a state, a word, one or two commands), so one table serves both. A mixed
// state offers both directions rather than guessing which the reader meant.
interface HalfAction {
    readonly command: DeviceCommand;
    readonly label: string;
    readonly hint: string;
}
interface DeviceSwitch {
    readonly label: string;
    readonly state: HalfState;
    /** The state in one word, for the settled positions. */
    readonly word: string;
    /** What disagrees, when the pairings do; replaces the word rather than joining it. */
    readonly note: string | undefined;
    // How much this switch touches, in the reader's units: every label says "all" without saying all of what.
    readonly scope: string;
    readonly actions: readonly HalfAction[];
}

const PAUSE: HalfAction = {
    command: `sync-pause`,
    label: `Pause all`,
    hint: `Stop moving files either way, for every sandbox this device syncs. Their ports keep being mirrored.`,
};
const RESUME: HalfAction = { command: `sync-resume`, label: `Resume all`, hint: `Start moving files again for every sandbox this device syncs.` };
const MIRROR_OFF: HalfAction = {
    command: `mirror-off`,
    label: `Stop all`,
    hint: `Take every paired sandbox's ports off this device's localhost. Files keep syncing.`,
};
const MIRROR_ON: HalfAction = { command: `mirror-on`, label: `Start all`, hint: `Put every paired sandbox's ports back on this device's localhost.` };

// A settled switch offers the way out; a mixed one offers both, rather than choosing for the reader.
const actionsFor = (state: HalfState, off: HalfAction, on: HalfAction): HalfAction[] =>
    state === `on` ? [off] : state === `off` ? [on] : [on, off];

// What "all" means on this row, counted rather than left to be found by unfolding the list.
const scopeOf = (half: DeviceHalf): string => `all ${half.total} sandboxes`;

const deviceSwitches = (row: DeviceRow): DeviceSwitch[] => {
    const switches: DeviceSwitch[] = [];
    const sync = syncHalf(row);
    if (switchable(row, sync)) {
        switches.push({
            label: `File syncing`,
            state: sync.state,
            word: sync.state === `off` ? `paused` : `on`,
            note: halfNote(sync, `paused`),
            scope: scopeOf(sync),
            actions: actionsFor(sync.state, PAUSE, RESUME),
        });
    }
    const mirror = mirrorHalf(row);
    if (switchable(row, mirror)) {
        switches.push({
            label: `Port mirroring`,
            state: mirror.state,
            word: mirror.state === `off` ? `off` : `on`,
            note: halfNote(mirror, `off`),
            scope: scopeOf(mirror),
            actions: actionsFor(mirror.state, MIRROR_OFF, MIRROR_ON),
        });
    }
    return switches;
};

// Unpairing doesn't undo itself (a fresh one-liner re-enrolls), so it parks in the app's own dialog like the
// container verbs above it.
const confirmingUnpair = ref<{ device: Device; group: DeviceSandboxGroup } | undefined>();
const confirmUnpair = (): void => {
    const pending = confirmingUnpair.value;
    confirmingUnpair.value = undefined;
    if (pending !== undefined) {
        void runSync(pending.device, rowKey(pending.device, pending.group), pending.group.sandboxId, `sync-unpair`);
    }
};

// Update and restart both stop the resident process that carries the request, so the row can't claim an
// outcome: it shows what was watched, then "restarting…", and the confirmation is the next poll's version.
const agentBusy = ref<{ key: string; op: DeviceAgentOp } | undefined>();
// Whether this device is between "we asked" and "its version moved"; kept per device so the note survives the
// call ending.
const agentWaiting = ref<Record<string, string>>({});
const agentLines = ref<Record<string, string[]>>({});

const AGENT_ASKED: Record<DeviceAgentOp, string> = {
    upgrade: `Updating its agent. The connection to this device drops while its loop restarts — this page shows the new version when it comes back.`,
    restart: `Restarting its agent. The connection to this device drops while that happens.`,
};

const runAgent = async (device: Device, op: DeviceAgentOp): Promise<void> => {
    if (device.hostId === undefined || working.value) {
        return;
    }
    const key = deviceKey(device);
    agentBusy.value = { key, op };
    actionError.value = undefined;
    actionDone.value = undefined;
    agentLines.value = { ...agentLines.value, [key]: [] };
    agentWaiting.value = { ...agentWaiting.value, [key]: AGENT_ASKED[op] };
    try {
        const { message } = await runDeviceAgentFlow(device.hostId, op, {
            onLine: (line) => (agentLines.value = { ...agentLines.value, [key]: [...(agentLines.value[key] ?? []), line] }),
        });
        // Only the device's own sentence, and only if it managed to send one; no fallback text.
        actionDone.value = message === undefined ? undefined : { key, message };
    } catch (failure) {
        // A refusal, not a lost connection: the client only throws for a frame the device actually sent. The waiting
        // note is dropped, since nothing is on its way back.
        actionError.value = { key, notice: noticeFrom(failure, `That device wouldn't update its agent.`) };
        agentWaiting.value = Object.fromEntries(Object.entries(agentWaiting.value).filter(([seen]) => seen !== key));
    } finally {
        agentBusy.value = undefined;
        // The version is the answer, so ask for it; the tab's own poll picks it up as the loop comes back.
        refetch();
    }
};

// Clears once the fact it was waiting for arrives (a live, unstalled, current loop); watched rather than
// computed so it survives a poll landing mid-restart.
watch(
    () => rows.value.map((row) => `${row.device.key}:${row.agent?.build ?? ``}:${row.chip?.installed ?? ``}:${row.chip?.available ?? ``}`).join(`|`),
    () => {
        const settled = new Set(
            rows.value
                .filter((row) => row.agent?.running === true && row.agent.stalled === false && row.agent.staleBuild === undefined && row.chip?.available === undefined)
                .map((row) => row.device.key),
        );
        agentWaiting.value = Object.fromEntries(Object.entries(agentWaiting.value).filter(([key]) => !settled.has(key)));
    },
);

// Never both: update is offered where something newer than the installed file has been published; restart
// where the loop itself is the problem (stopped, stalled, or serving an old build), where an update would
// honestly answer "nothing to do".
const canUpdateAgent = (row: DeviceRow): boolean =>
    row.device.hostId !== undefined && row.device.online === true && row.device.gap === undefined && agentBehind(row.device, latest.value);
const canRestartAgent = (row: DeviceRow): boolean =>
    row.device.hostId !== undefined &&
    row.device.online === true &&
    row.device.gap === undefined &&
    (row.agent?.running === false || row.agent?.stalled === true || row.agent?.staleBuild !== undefined);

// Drops the key from the sandbox rather than asking the device to clean up (Unpair does that): the only path
// that works for a laptop that's lost, wiped, or someone else's. Owner-only, per machine, no fleet-wide
// equivalent.
const { isOwner } = useRole();
const confirmingRevoke = ref<Device | undefined>();
const revoking = ref(false);
const runRevoke = async (): Promise<void> => {
    const device = confirmingRevoke.value;
    // The enrollment may have vanished between opening this dialog and confirming it; nothing left to revoke
    // closes it quietly.
    if (device?.sync === undefined) {
        confirmingRevoke.value = undefined;
        return;
    }
    revoking.value = true;
    actionError.value = undefined;
    actionDone.value = undefined;
    try {
        await revokeSyncDevice(device.sync.machine);
        confirmingRevoke.value = undefined;
        actionDone.value = { key: device.key, message: `${device.label} no longer has access to this sandbox.` };
    } catch (failure) {
        actionError.value = { key: device.key, notice: noticeFrom(failure, `Couldn't revoke that device's access.`) };
        confirmingRevoke.value = undefined;
    } finally {
        revoking.value = false;
        // The row is losing its enrollment either way, so refetch regardless of whether the call itself succeeded.
        refetch();
    }
};
</script>

<template>
    <div class="flex flex-col gap-4">
        <RowGroup label="Devices" :count="sorted.length === 0 ? undefined : sorted.length">
            <!--
                The other half of the Ports tab's cross-link: both are about "ports" in opposite directions (out to the
                internet there, in to this machine here), so each says which.
            -->
            <template #info>
                <InfoHint label="Devices">
                    <span class="block text-sm font-medium text-content">Your own machines</span>
                    <span class="mt-1 block text-xs text-muted">
                        Every device paired with this sandbox: the folder it syncs, the ports it mirrors to your <b>localhost</b>, and the sandboxes
                        running on it.
                    </span>
                    <span class="mt-2 block text-xs text-muted">
                        A port that couldn't be mirrored shows under the sandbox that claimed it first. To expose a port to the public internet, use
                        the
                        <b>Ports</b> tab.
                    </span>
                </InfoHint>
            </template>
            <!-- Read inside the desktop app, whose own window needs no capability, since it runs on the device it manages. -->
            <RowNote v-if="inDesktopApp" icon="desktop">
                This device's own sandboxes are also in <b>This device</b>, from the Intentic icon in your tray.
            </RowNote>
            <!-- Is anything wrong right now, answered before a row is parsed. -->
            <template #actions>
                <StatusTally v-if="!isLoading && sorted.length > 0" :items="tally" />
            </template>
            <!-- Shown only once there's something to search; ports are matched too. -->
            <RowNote v-if="!isLoading && showFilter" variant="block">
                <SearchBar
                    v-model="query"
                    variant="field"
                    placeholder="Filter by device, sandbox, folder or port"
                    aria-label="Filter devices"
                    :clearable="true"
                />
            </RowNote>
            <Notice v-if="computersNotice" :of="computersNotice" class="m-4" />
            <div v-else-if="isLoading" role="status" aria-busy="true">
                <template v-if="outline">
                    <span class="sr-only">Reading your devices…</span>
                    <SkeletonRows :rows="2" description />
                </template>
            </div>
            <RowNote v-else-if="sorted.length === 0" variant="empty">
                No device is paired with this sandbox yet. Enable desktop sync below to work on it from your own editor, or add a Linux/Windows PC
                from Capabilities to let the agent work there.
            </RowNote>
            <!--
                One device, one row, rebuilt on <DisclosureRow> so it lights up like the rest of the hub; the rows inside
                are a <DeviceDetail> report on an already-open row rather than a second wash.
            -->
            <DisclosureRow
                v-for="row in shown"
                :key="row.device.key"
                :open="expandable(row) ? deviceOpen(row) : true"
                :disabled="!expandable(row)"
                @update:open="toggleDevice(row)"
            >
                <!--
                    The tier's own badge, sized off the tier rather than typed, so a device's mark and a sandbox row's dot
                    cannot drift apart.
                -->
                <template #lead="{ mark }">
                    <!-- Keeps the chevron's column even on a device with nothing to expand, so the list reads down one edge. -->
                    <span v-if="!expandable(row)" class="w-[0.6rem] shrink-0" aria-hidden="true"></span>
                    <span
                        class="flex shrink-0 items-center justify-center rounded-md bg-content/10 text-content"
                        :style="{ width: `${mark}px`, height: `${mark}px` }"
                    >
                        <Icon name="desktop" class="text-xs" />
                    </span>
                </template>

                <template #title>
                    <span class="flex min-w-0 flex-wrap items-center gap-x-2.5 gap-y-1">
                        <!-- Semibold against the tier's own medium, to outrank the sandbox names nested inside it. -->
                        <span class="min-w-0 truncate font-semibold">{{ row.device.label }}</span>
                        <!-- The OS beside the name, since it's what tells two identically-labelled devices apart at a glance. -->
                        <span v-if="osLabel(row.device)" class="shrink-0 truncate text-xs font-normal text-muted" :title="osTitle(row.device)">
                            {{ osLabel(row.device) }}
                        </span>
                        <span v-for="door in deviceDoors(row.device)" :key="door.name" :class="DOOR">
                            <Icon name="sync" class="text-2xs text-subtle" />
                            {{ door.name }}
                        </span>
                        <!--
                            The agent as its own chip: the version belongs to the binary, not to whichever door happens to be tagged
                            beside it. Shows the build serving; installed earns a word only when it differs.
                        -->
                        <span v-if="row.chip" :class="DOOR">
                            <Icon name="sparkles" class="text-2xs text-subtle" />
                            agent
                            <span class="font-mono text-subtle">{{ row.chip.version }}</span>
                            <!--
                                Both can be true at once (replaced but not restarted, and something newer published), so neither hides the
                                other.
                            -->
                            <span v-if="row.chip.installed" class="font-mono text-warning">{{ row.chip.installed }} installed, restart owed</span>
                            <span v-if="row.chip.available" class="font-mono text-warning">{{ row.chip.available }} available</span>
                        </span>
                    </span>
                </template>

                <!--
                    What the folded line still answers: how much is under here, and whether it wants something. Hidden once
                    open, where every fact below states itself in full.
                -->
                <template #meta>
                    <template v-if="!deviceOpen(row)">
                        <span v-for="fact in row.facts" :key="fact" class="shrink-0">{{ fact }}</span>
                        <span v-for="warning in row.warnings" :key="warning" class="truncate text-warning">{{ warning }}</span>
                        <span v-if="lastSeenNote(row.device)" class="shrink-0">{{ lastSeenNote(row.device) }}</span>
                    </template>
                    <StatusBadge :variant="tone(row.device)" size="xs" :dot="true" :label="label(row.device)" class="shrink-0" />
                </template>

                <!--
                    Railed off its own header rather than indented, so a three-tier-deep expansion has a visible edge; the
                    indent is measured off the toggle cluster above it.
                -->
                <template #below>
                    <div class="flex flex-col gap-3">
                        <!--
                            What this device is doing for the sandbox, first, since it's the one thing anybody opened the row to read.
                            Warning ink when the enrollment has stopped checking in.
                        -->
                        <p
                            v-if="syncNote(row.device, now)"
                            class="min-w-0 text-xs"
                            :class="syncStopped(row.device, now) ? `text-warning` : `text-muted`"
                        >
                            {{ syncNote(row.device, now) }}
                        </p>
                        <!-- What the box is, in the quietest ink: read once per device, mostly to tell two identically-named ones apart. -->
                        <p v-if="deviceHardware(row.device).length > 0" class="min-w-0 truncate text-2xs text-subtle">
                            {{ deviceHardware(row.device).join(` · `) }}
                        </p>

                        <!--
                            The same two commands the pairing rows below carry, run bare (every sandbox this machine pairs) — the switch
                            reached for when working on something else on this laptop.
                        -->
                        <div v-if="switchable(row, syncHalf(row)) || switchable(row, mirrorHalf(row))" class="flex flex-col gap-2 rounded-lg bg-content/2 px-3 py-2 border border-line-subtle/50">
                            <div v-for="half in deviceSwitches(row)" :key="half.label" class="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5">
                                <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                                    <span class="text-xs font-medium text-content">{{ half.label }}</span>
                                    <span class="inline-flex items-center rounded px-1.5 py-0.5 text-2xs font-medium" :class="half.state === 'off' ? 'bg-content/5 text-subtle' : 'bg-success/10 text-success'">
                                        {{ half.note ?? half.word }}
                                    </span>
                                    <!-- What "all" means: every label here says "all" without saying all of what. -->
                                    <span class="text-2xs text-subtle">{{ half.scope }}</span>
                                </div>
                                <div class="flex flex-wrap items-center gap-1.5">
                                    <Button
                                        v-for="action in half.actions"
                                        :key="action.command"
                                        size="small"
                                        severity="secondary"
                                        :label="action.label"
                                        :loading="syncBusy?.key === deviceKey(row.device) && syncBusy.command === action.command"
                                        :disabled="working"
                                        v-tooltip.top="action.hint"
                                        @click="void runSync(row.device, deviceKey(row.device), undefined, action.command)"
                                    />
                                </div>
                            </div>
                            <!--
                                The machine's own answer to a machine-level click, shown where the click was; pairing rows have their own
                                footer.
                            -->
                            <Notice v-if="actionError?.key === deviceKey(row.device)" :of="actionError.notice" />
                            <p v-else-if="actionDone?.key === deviceKey(row.device)" class="text-xs text-muted">{{ actionDone.message }}</p>
                        </div>

                        <!--
                            The agent as one block: what it's doing, which build, and the two buttons, rather than scattered across
                            three tiers as before.
                        -->
                        <div v-if="row.agent || canUpdateAgent(row) || agentWaiting[row.device.key]" class="flex flex-col gap-2 rounded-lg border border-line-subtle/50 bg-content/2 px-3 py-2">
                            <div class="flex flex-wrap items-center justify-between gap-x-4 gap-y-1.5">
                                <div class="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-0.5">
                                    <span class="text-xs font-medium text-content">Agent</span>
                                    <!--
                                        Running is the resting state and says so quietly; the two failures keep a badge, since either means the rows
                                        below may be stale.
                                    -->
                                    <template v-if="row.agent">
                                        <StatusBadge v-if="row.agent.stalled" variant="warning" size="xs" :dot="true" label="stalled" />
                                        <StatusBadge v-else-if="!row.agent.running" variant="warning" size="xs" :dot="true" label="stopped" />
                                        <span v-else class="inline-flex items-center gap-1.5 text-2xs text-muted">
                                            <span class="h-1.5 w-1.5 rounded-full bg-success"></span>
                                            running
                                        </span>
                                        <span v-if="row.agent.running && row.agent.pid !== undefined" class="font-mono text-2xs text-subtle">
                                            pid {{ row.agent.pid }}
                                        </span>
                                    </template>
                                    <!-- The header chip's two numbers, restated where they're acted on, shown only when they say something. -->
                                    <span v-if="row.chip?.installed" class="text-2xs text-warning">
                                        serving {{ row.chip.version }}, {{ row.chip.installed }} installed
                                    </span>
                                    <span v-else-if="row.chip?.available" class="text-2xs text-warning">{{ row.chip.available }} available</span>
                                </div>
                                <div class="flex flex-wrap items-center gap-1.5">
                                    <!-- Offered where something newer than the installed file has been published. -->
                                    <Button
                                        v-if="canUpdateAgent(row)"
                                        size="small"
                                        severity="secondary"
                                        label="Update agent"
                                        :loading="agentBusy?.key === deviceKey(row.device) && agentBusy.op === `upgrade`"
                                        :disabled="working"
                                        v-tooltip.top="`Download and install the current agent on this device, then restart its loop. Its folders, pairings and mirrored ports are untouched.`"
                                        @click="void runAgent(row.device, `upgrade`)"
                                    />
                                    <!--
                                        Offered where the loop itself is the problem (stopped, stalled, or serving an old build) — the state where
                                        update would answer "nothing to do".
                                    -->
                                    <Button
                                        v-if="canRestartAgent(row)"
                                        size="small"
                                        severity="secondary"
                                        label="Restart agent"
                                        :loading="agentBusy?.key === deviceKey(row.device) && agentBusy.op === `restart`"
                                        :disabled="working"
                                        v-tooltip.top="`Stop and start this device's agent loop. Nothing is downloaded, and the build already installed there is the one that comes up.`"
                                        @click="void runAgent(row.device, `restart`)"
                                    />
                                </div>
                            </div>
                            <!--
                                This op takes its own connection down (the loop being restarted carries the request), so the stream always
                                stops mid-sentence with no outcome to report.
                            -->
                            <p v-if="agentWaiting[row.device.key]" class="text-xs text-muted">{{ agentWaiting[row.device.key] }}</p>
                            <DeviceRunLog
                                v-if="agentBusy?.key === deviceKey(row.device) || (agentLines[row.device.key] ?? []).length > 0"
                                :lines="agentLines[row.device.key] ?? []"
                                :running="agentBusy?.key === deviceKey(row.device)"
                                empty="Starting on that device…"
                                note="Running on that device. It keeps going even if you leave this page, and it survives the connection dropping."
                            />
                            <Notice v-if="actionError?.key === deviceKey(row.device) && agentLines[row.device.key]" :of="actionError.notice" />
                        </div>

                        <!-- What else the row wants, if anything, each on its own line; the agent's own remedies are the block above. -->
                        <div
                            v-if="(row.device.report && reportStale(row.device, now)) || row.device.gap || blockText(row.device)"
                            class="flex flex-col gap-1"
                        >
                            <!-- The reading's own age: a report is a snapshot of a device that may since have closed its lid. -->
                            <p v-if="row.device.report && reportStale(row.device, now)" class="text-xs text-warning">
                                Last heard from {{ timeAgo(row.device.report.capturedAt) }}. What follows is what it looked like then.
                            </p>
                            <p v-if="row.device.gap" class="text-xs text-muted">{{ GAP_TEXT[row.device.gap] }}</p>
                            <!--
                                Why the sandbox list below has no buttons, and the one click that changes it; quiet ink, since none of this
                                is a fault.
                            -->
                            <div v-if="blockText(row.device)" class="flex flex-wrap items-center gap-x-2 gap-y-1">
                                <p class="min-w-0 text-xs text-muted">
                                    {{ blockText(row.device) }}
                                    <!-- Kept on one line: a command broken across a wrap can't be copied by eye. -->
                                    <template v-if="blockCommand(row.device)">
                                        Run <span class="font-mono whitespace-nowrap text-content">{{ blockCommand(row.device) }}</span> on that
                                        device.
                                    </template>
                                </p>
                                <!-- A link wearing the button's clothes, since the fix has an address: hoverable and Ctrl/⌘-clickable. -->
                                <Button
                                    v-if="blockAction(row.device)"
                                    :as="RouterLink"
                                    :to="fixAt(row.device)"
                                    size="small"
                                    severity="secondary"
                                    :text="true"
                                    :label="blockAction(row.device)"
                                >
                                    <template #icon><Icon name="arrow-up-right" /></template>
                                </Button>
                            </div>
                        </div>

                        <!--
                            One row per sandbox, folded to a line that says whether it's fine; only a machine that reported can say any
                            of it.
                        -->
                        <div v-if="row.device.report" class="border-t border-line-subtle pt-3">
                            <!--
                                No `agent` prop from here, deliberately: that state now has its own block above rather than riding this
                                heading as a second liveness statement.
                            -->
                            <DeviceDetail
                                :pairings="row.device.report.pairings"
                                :ports="row.device.report.ports"
                                :sandboxes="row.device.report.sandboxes"
                                :open="row.open"
                                :undivided="true"
                            >
                                <template #heading><span :class="SUBHEAD">Sandboxes on this device</span></template>
                                <!-- The one row on this page that can close the page, said beside the name rather than only in the confirmation. -->
                                <template #badges="{ group }">
                                    <StatusBadge v-if="isSelf(row.device, group)" variant="info" size="xs" label="the one you're using" />
                                </template>
                                <!-- The verbs are the kit's, so this tab and the desktop app's manager window offer the same row. -->
                                <template #actions="{ group }">
                                    <SandboxVerbs
                                        v-if="manageable(row.device, group)"
                                        :running="group.sandbox?.running === true"
                                        :busy="runningVerb(row.device, group)"
                                        :disabled="working"
                                        :logs-open="logShown(row.device, group)"
                                        @act="(verb) => act(row.device, group, verb)"
                                    />
                                </template>
                                <!--
                                    Controls for this pairing's files, under the folder rather than up with the container verbs: Pause stops no
                                    container, only the file movement.
                                -->
                                 <template #folder="{ group }">
                                     <div class="mt-1 flex flex-wrap items-center gap-2">
                                         <!--
                                             First, since a row with conflicts is open because of them; starts a turn rather than a command, because
                                             choosing between two edited copies is per-file judgement (see conflictAsk.ts).
                                         -->
                                         <Button
                                             v-if="fixable(row.device, group)"
                                             size="small"
                                             severity="secondary"
                                             label="Fix with agent"
                                             :disabled="working"
                                             v-tooltip.top="conflictTurn(row.device, group).hint"
                                             @click="startAgent(conflictTurn(row.device, group).prompt)"
                                         >
                                             <template #icon><Icon name="sparkles" /></template>
                                         </Button>
                                         <Button
                                             v-if="pausable(row.device, group)"
                                             size="small"
                                             severity="secondary"
                                             :label="group.folder?.paused === true ? `Resume syncing` : `Pause syncing`"
                                             :loading="syncRunning(row.device, group, `sync-pause`)"
                                             :disabled="working"
                                             v-tooltip.top="
                                                 group.folder?.paused === true
                                                     ? `Start moving files between this device and the sandbox again`
                                                     : `Stop moving files either way. The sandbox keeps running and its ports keep being mirrored.`
                                             "
                                             @click="
                                                 void runSync(
                                                     row.device,
                                                     rowKey(row.device, group),
                                                     group.sandboxId,
                                                     group.folder?.paused === true ? `sync-resume` : `sync-pause`,
                                                 )
                                             "
                                         />
                                         <!--
                                             The one control here nothing undoes in a click. Asks the machine to unpair, so its agent tears down its
                                             own
                                             sessions and self-revokes.
                                         -->
                                         <Button
                                             v-if="commandable(row.device, group)"
                                             size="small"
                                             severity="danger"
                                             :text="true"
                                             label="Unpair"
                                             :loading="syncRunning(row.device, group, `sync-unpair`)"
                                             :disabled="working"
                                             v-tooltip.top="`Stop this device syncing this sandbox. Its local folder is left exactly as it is.`"
                                             @click="confirmingUnpair = { device: row.device, group }"
                                         />
                                     </div>
                                 </template>
                                 <!--
                                     The switch that clears the user's own localhost, under the ports it's about rather than with the container
                                     verbs; its label points whichever way the machine currently says.
                                 -->
                                 <template #ports="{ group }">
                                     <div class="mt-1 flex flex-wrap items-center gap-2">
                                         <Button
                                             v-if="commandable(row.device, group)"
                                             size="small"
                                             severity="secondary"
                                             :label="mirroringOff(group.folder) ? `Start mirroring` : `Stop mirroring`"
                                             :loading="syncRunning(row.device, group, `mirror-off`)"
                                             :disabled="working"
                                             v-tooltip.top="
                                                 mirroringOff(group.folder)
                                                     ? `Put this sandbox's ports back on this device's localhost`
                                                     : `Take this sandbox's ports off this device's localhost. Files keep syncing.`
                                             "
                                             @click="
                                                 void runSync(
                                                     row.device,
                                                     rowKey(row.device, group),
                                                     group.sandboxId,
                                                     mirroringOff(group.folder) ? `mirror-on` : `mirror-off`,
                                                 )
                                             "
                                         />
                                     </div>
                                 </template>
                                <!-- The machine's own output, visible while a row works and afterward for as long as its log is being read. -->
                                <template #footer="{ group }">
                                    <DeviceRunLog
                                        v-if="busy?.startsWith(`${rowKey(row.device, group)}:`) || logShown(row.device, group)"
                                        :lines="runLines[rowKey(row.device, group)] ?? []"
                                        :running="busy?.startsWith(`${rowKey(row.device, group)}:`) === true"
                                        empty="Starting on that device…"
                                        note="Running on that device. It keeps going even if you leave this page."
                                    />
                                    <Notice v-if="actionError?.key === rowKey(row.device, group)" :of="actionError.notice" />
                                    <p v-else-if="actionDone?.key === rowKey(row.device, group)" class="text-xs text-muted">
                                        {{ actionDone.message }}
                                    </p>
                                </template>
                            </DeviceDetail>
                        </div>

                        <!--
                            What this sandbox keeps here, as opposed to what the person does: runners it can hand a conversation to.
                            Outside the report gate, since a device that never reported may still hold one.
                        -->
                        <DeviceRunners :device="row.device" />

                        <!--
                            Cutting this device off entirely, at the bottom since it ends everything above it at once; the machine-level
                            twin of Unpair, for a laptop Unpair can't reach.
                        -->
                        <div v-if="row.device.sync && isOwner" class="flex flex-wrap items-center justify-between gap-x-4 gap-y-2 border-t border-line-subtle pt-3">
                            <p class="min-w-0 flex-1 text-xs text-muted">
                                Revoking stops this device reaching the sandbox at all. Nothing on it is deleted, and its agent stays installed.
                            </p>
                            <Button
                                size="small"
                                severity="danger"
                                label="Revoke access"
                                :disabled="working || revoking"
                                @click="confirmingRevoke = row.device"
                            >
                                <template #icon><Icon name="times" /></template>
                            </Button>
                        </div>
                    </div>
                </template>
            </DisclosureRow>
            <!-- A filter that matched nothing says so, rather than leaving a group that looks empty by accident. -->
            <RowNote v-if="shown.length === 0 && sorted.length > 0" variant="empty"> No device or sandbox here matches "{{ query }}". </RowNote>
        </RowGroup>

        <DesktopSyncCard :highlight="highlight" />
        <!--
            The editor bridge (ACP): runs this sandbox's agents from any ACP editor, using the editor slice of the
            Access tab's API tokens.
        -->
        <ControlTokensSection :scopes="[`editor`]" :snippets="[`acp`]" :roster="false" default-expiry="never" />

        <!-- Red only for removal: an image swap keeps the sandbox's files, so it isn't destructive. -->
        <ConfirmDialog
            :open="confirmingAct !== undefined"
            :header="actPrompt?.header ?? ``"
            :confirm-label="actPrompt?.label ?? `Continue`"
            :destructive="actPrompt?.destructive === true"
            @cancel="confirmingAct = undefined"
            @confirm="confirmAct"
        >
            <p v-if="actPrompt?.body !== undefined">{{ actPrompt.body }}</p>
            <p v-if="actPrompt?.severing === true" class="mt-3 text-xs text-warning">
                This is the sandbox you are using right now — this page will lose it.
            </p>
        </ConfirmDialog>

        <!--
            The sandbox's share of its machine, as the kit's form: current caps, the engine's size for the rails, and
            whether this row is the sandbox serving the page.
        -->
        <SandboxResourcesDialog
            :open="reshaping !== undefined"
            :name="reshaping?.group.title ?? ``"
            :current="reshaping?.group.sandbox?.resources"
            :engine="reshaping?.device.facts?.engine"
            :self-warning="reshaping !== undefined && isSelf(reshaping.device, reshaping.group)"
            @cancel="reshaping = undefined"
            @apply="applyReshape"
        />

        <!-- Names what survives as carefully as what ends: the local folder is untouched. -->
        <ConfirmDialog
            :open="confirmingUnpair !== undefined"
            :header="`Unpair ${confirmingUnpair?.group.title ?? `this sandbox`}?`"
            confirm-label="Unpair"
            :destructive="true"
            @cancel="confirmingUnpair = undefined"
            @confirm="confirmUnpair"
        >
            <p>
                <span class="font-mono text-content">{{ confirmingUnpair?.device.label }}</span> stops syncing this sandbox's files and mirroring its
                ports. Everything already in its local folder stays exactly as it is.
            </p>
            <p v-if="confirmingUnpair?.group.folder?.localDir" class="mt-2 break-all font-mono text-xs text-content">
                {{ confirmingUnpair.group.folder.localDir }}
            </p>
            <p class="mt-2">Pairing it again means running a fresh command on that device.</p>
        </ConfirmDialog>

        <!--
            Named for the machine, explicit that it's this one alone: the button it replaced revoked every paired device
            at once.
        -->
        <ConfirmDialog
            :open="confirmingRevoke !== undefined"
            :header="`Revoke ${confirmingRevoke?.label ?? `this device`}'s access?`"
            confirm-label="Revoke access"
            confirm-icon="times"
            :destructive="true"
            :loading="revoking"
            @cancel="confirmingRevoke = undefined"
            @confirm="runRevoke"
        >
            <p>
                This device alone loses access — every other paired device keeps syncing. Its file sync stops and its mirrored ports drop off its
                localhost within a minute.
            </p>
            <p class="mt-2">
                Nothing on that device is deleted and its agent stays installed, but letting it back in means running a fresh pairing command there.
            </p>
        </ConfirmDialog>
    </div>
</template>
