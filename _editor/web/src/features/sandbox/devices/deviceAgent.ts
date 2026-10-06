import type { Device, DeviceAgentOp } from "@intentic/sandbox-contract";
// The kit's DOM-free subpath, not the barrel: this module is pure, and its tests run without a document.
import {
    type AgentAction,
    agentStateNote,
    agentProcessState,
    type AgentNote,
    type AgentPanel,
    agentSkewNote,
    restartAgent,
} from "@intentic/ui/device-agent";
import { agentBehind, deviceReconnecting } from "./deviceFacts";
import type { DeviceRow, MachineRow } from "./deviceRows";
import { environmentTitle } from "./machineEnvironments";
import { t } from "@intentic/ui/i18n";

// What this sandbox's device registry knows about one machine's agent, folded into the kit's AgentPanel —
// the shape <DeviceAgentGroup> draws on both this tab and the desktop app's manager window. The wording every
// caller shares lives in the kit; what is here is what only a registry can answer: whether the machine is
// reachable at all, and whether a newer agent has been published.
// Pure, so every rule below is checkable without mounting anything (deviceAgent.test.ts).

// When the registry knows this device is current, Restart stays available and Update does not offer a no-op.

/** This tab's panel: every op the contract names, since a connected machine can hear all of them. */
export type DeviceAgentPanel = AgentPanel<DeviceAgentOp>;

// Worded for a current agent as much as a stale one, since it is offered on both: "the newest there is",
// never "the newest we know of", because the device resolves that for itself when it downloads. This hint is
// where the panel keeps what it no longer says out loud — that it moves every side of the PC, and what it leaves alone.
const upgrade = (): AgentAction<DeviceAgentOp> => ({
    op: `upgrade`,
    label: t(`sandbox.deviceAgent.updateAgent`),
    hint: { title: t(`sandbox.deviceAgent.updatesEverySide`), note: t(`sandbox.deviceAgent.foldersPortsUntouched`) },
});

// Update leads: it is the errand people come to this group for, and it restarts the loop on its way past,
// which makes Restart the narrower of the two rather than the first thing to try.
// `forget-unreachable` is deliberately NOT here. These two are standing verbs, offered whether or not anything is
// wrong; the drop only means something when a machine is holding links that stopped answering, so it is raised as
// that concern's own fix (health/deviceAttention.ts) and would be a question nobody asked anywhere else.
const actions = (): readonly AgentAction<DeviceAgentOp>[] => [upgrade(), restartAgent()];

// Restart alone on a side of a many-sided machine: an update moves every side, so it is the machine's button (machineAgent).
const restartOnly = (): readonly AgentAction<DeviceAgentOp>[] => [restartAgent()];

// Every verb here travels over the device's own outbound socket, so a machine not holding one gets the
// sentence without the controls. Wider than the container verbs' `commandable`, by one case: a device
// holding a socket while sending no report is usually one whose agent predates machine reports, which is
// exactly the machine an update fixes, and the one this view used to answer with a command to go and type.
// An agent too old to have the flow at all refuses in its own words, which is an answer either way. And wider by a
// second: "Run commands" off stops the machine's report, not these, which are the owner's own maintenance and ride no
// switch of the agents' (tools/agent.ts in the machine agent); one from before that refuses and names the switch.
const reachable = (device: Device): boolean =>
    device.hostId !== undefined &&
    device.online === true &&
    (device.gap === undefined || device.gap === `unreported` || device.gap === `scope-off`);

const syncOnly = (): AgentNote => ({
    text: t(`sandbox.deviceAgent.syncOnly`),
    icon: `lock`,
    hint: { title: t(`sandbox.deviceAgent.notADevice`), note: t(`sandbox.deviceAgent.connectToUpdate`) },
});

// The one case with no errand in it, and the only line on screen while it holds: the concerns strip stands down
// for a socket this young (deviceAttention.ts), so this is what explains the missing buttons.
const reconnecting = (): AgentNote => ({
    text: t(`sandbox.deviceAgent.reconnectingNote`),
    icon: `sync`,
    hint: { title: t(`sandbox.deviceAgent.socketDropped`), note: t(`sandbox.deviceAgent.redialsByItself`) },
});

// Only what the concerns strip does NOT already say. Every gap has a sentence there, and a machine holding no
// socket wears `offline` on its badge, so naming either again is how one silence came to be stated four times.
// The two left are the two nothing else covers: an enrollment that was never a device, and a socket young enough
// that the strip deliberately stands down (deviceAttention.ts).
const blockedWhy = (device: Device, readAt: number): AgentNote | undefined => {
    if (reachable(device)) {
        return undefined;
    }
    if (device.hostId === undefined) {
        return syncOnly();
    }
    return deviceReconnecting(device, readAt) ? reconnecting() : undefined;
};

// Two states only a registry can be in, ahead of the loop's own three (agentProcessState).
const stateOf = (row: DeviceRow, readAt: number): AgentPanel[`state`] => {
    // A loop whose socket dropped seconds ago reported perfectly well a moment before; the reading is missing
    // because the machine is between connections, which is the badge's own word for it rather than the absence.
    if (deviceReconnecting(row.device, readAt)) {
        return { word: t(`sandbox.deviceAgent.reconnecting`), variant: `neutral` };
    }
    // A machine that has never reported has an agent this sandbox has only ever been dialled by; its
    // version is known from the hello frame, its loop is not.
    if (row.agent === undefined) {
        return { word: t(`sandbox.deviceAgent.notReported`), variant: `neutral` };
    }
    return agentProcessState(row.agent);
};

// Judged on the installed build, since that is what an update downloads over; a device whose only problem is
// a stale loop is agentSkewNote's, not this one's.
const publishedNote = (row: DeviceRow, latest: string): AgentNote => {
    const held = row.device.report?.agent.installed ?? row.chip?.version;
    return {
        text: held === undefined ? t(`sandbox.deviceAgent.publishedForMachine`, { latest }) : t(`sandbox.deviceAgent.publishedDeviceHas`, { latest, held }),
        tone: `info`,
        hint: { title: t(`sandbox.deviceAgent.updateAgent`), note: t(`sandbox.deviceAgent.fetchInstallRestart`) },
    };
};

// The `ic` this agent drives is older than the agent and fetching the current one failed, which is what leaves a
// current agent without the verbs its release has (logs, saving a shape for the next restart). In the agent's own
// sentence: it names both versions and why the fetch failed, and that the next sandbox action tries again.
const icNote = (device: Device): AgentNote | undefined => {
    const stale = device.facts?.icOutOfDate;
    return stale === undefined || stale.trim() === `` ? undefined : { text: stale, tone: `warning` };
};

// One sentence per distinct errand, worst first; a stale loop and a published release can both be true at
// once (replaced but not restarted, and something newer out since), so neither hides the other. A settled agent
// says nothing: whether this sandbox knows the newest release is a fact about this sandbox, not about the
// machine, and printing it under every environment was the page's most-repeated line. What Update is for on an
// agent asking for nothing lives on Update's own hint.
const notesOf = (row: DeviceRow, latest: string | undefined): AgentNote[] => {
    const behind = latest !== undefined && agentBehind(row.device, latest);
    return [agentStateNote(row.agent), agentSkewNote(row.agent?.staleBuild), icNote(row.device), behind ? publishedNote(row, latest) : undefined].filter(
        (note) => note !== undefined,
    );
};

// None on a side that cannot hear them; Restart alone where the machine owns the update.
const actionsOf = (device: Device, update: boolean, latest: string | undefined): readonly AgentAction<DeviceAgentOp>[] => {
    if (!reachable(device)) {
        return [];
    }
    const installed = device.report?.agent.installed;
    return update && (latest === undefined || installed === undefined || agentBehind(device, latest)) ? actions() : restartOnly();
};

// Nothing to say and nothing to do: a machine with no version from either door and no command door is one
// this group would draw an empty heading for.
export const deviceAgentPanel = (
    row: DeviceRow,
    latest: string | undefined,
    readAt: number,
    // False on each side of a many-sided machine, whose update and published release are the machine's (machineAgent).
    { update = true }: { readonly update?: boolean } = {},
): DeviceAgentPanel | undefined => {
    const { device } = row;
    const version = row.chip?.version;
    if (version === undefined && device.hostId === undefined) {
        return undefined;
    }
    const pid = row.agent?.pid;
    return {
        version,
        state: stateOf(row, readAt),
        facts: pid === undefined ? [] : [`pid ${pid}`],
        notes: notesOf(row, update ? latest : undefined),
        actions: actionsOf(device, update, latest),
        blocked: blockedWhy(device, readAt),
    };
};

// A many-sided machine's one Update, and what only the machine as a whole can say about its agents.
export interface MachineAgent {
    // The Windows side when it can hear, since it updates its distros first and itself last; else any side that can.
    readonly door: DeviceRow | undefined;
    readonly action: AgentAction<DeviceAgentOp>;
    readonly updateNeeded: boolean;
    readonly notes: readonly AgentNote[];
}

interface HeldVersion {
    readonly row: DeviceRow;
    readonly version: string;
}

// The build each side has on disk, which is what an update replaces; a side that never named one is left out.
const heldVersions = (environments: readonly DeviceRow[]): HeldVersion[] =>
    environments.flatMap((row) => {
        const version = row.device.report?.agent.installed ?? row.chip?.version;
        return version === undefined ? [] : [{ row, version }];
    });

// Sides on different builds are one errand for the machine, not one per side: the same Update closes it.
const splitNote = (held: readonly HeldVersion[]): AgentNote | undefined =>
    new Set(held.map((entry) => entry.version)).size < 2
        ? undefined
        : {
              text: t(`sandbox.deviceAgent.sidesRunDifferentAgents`, {
                  sides: held.map(({ row, version }) => `${environmentTitle(row)} ${version}`).join(`, `),
              }),
              tone: `warning`,
              hint: { title: t(`sandbox.deviceAgent.shouldMatch`), note: t(`sandbox.deviceAgent.updateAlignsAll`) },
          };

// Names what the machine holds only when that is one version; a split already listed each side's above it.
const machinePublishedNote = (
    environments: readonly DeviceRow[],
    held: readonly HeldVersion[],
    latest: string | undefined,
): AgentNote | undefined => {
    if (latest === undefined || !environments.some((row) => agentBehind(row.device, latest))) {
        return undefined;
    }
    const versions = [...new Set(held.map((entry) => entry.version))];
    const [only] = versions;
    return {
        text:
            versions.length === 1 && only !== undefined
                ? t(`sandbox.deviceAgent.publishedMachineHas`, { latest, held: only })
                : t(`sandbox.deviceAgent.publishedForMachine`, { latest }),
        tone: `info`,
        hint: { title: t(`sandbox.deviceAgent.updateAgent`), note: t(`sandbox.deviceAgent.fetchInstallRestart`) },
    };
};

export const machineAgent = (machine: MachineRow, latest: string | undefined): MachineAgent => {
    const hearing = machine.environments.filter((row) => reachable(row.device));
    const held = heldVersions(machine.environments);
    return {
        door: hearing.find((row) => row.device.platform === `windows`) ?? hearing[0],
        action: upgrade(),
        updateNeeded: latest === undefined || held.length < machine.environments.length || machine.environments.some((row) => agentBehind(row.device, latest)),
        notes: [splitNote(held), machinePublishedNote(machine.environments, held, latest)].filter((note) => note !== undefined),
    };
};
