import type { Device, DeviceAgentOp } from "@intentic/sandbox-contract";
// The kit's DOM-free subpath, not the barrel: this module is pure, and its tests run without a document.
import {
    type AgentAction,
    agentLoopNote,
    agentLoopState,
    type AgentNote,
    type AgentPanel,
    agentSkewNote,
    restartAgent,
} from "@intentic/ui/device-agent";
import { agentBehind, deviceReconnecting } from "./deviceFacts";
import type { DeviceRow } from "./deviceRows";
import { t } from "@intentic/ui/i18n";

// What this sandbox's device registry knows about one machine's agent, folded into the kit's AgentPanel —
// the shape <DeviceAgentGroup> draws on both this tab and the desktop app's manager window. The wording every
// caller shares lives in the kit; what is here is what only a registry can answer: whether the machine is
// reachable at all, and whether a newer agent has been published.
// Pure, so every rule below is checkable without mounting anything (deviceAgent.test.ts).

// Both verbs are offered whenever the machine can hear them, not only when this sandbox has decided
// something is wrong. An update gated on a registry comparison is no update at all on a dev build, on a
// sandbox that never reached the registry, or on an agent published since this sandbox last looked — and
// each of those is a walk to the machine to type `intentic-machine upgrade` by hand.

/** This tab's panel: every op the contract names, since a connected machine can hear all of them. */
export type DeviceAgentPanel = AgentPanel<DeviceAgentOp>;

// Worded for a current agent as much as a stale one, since it is offered on both: "the newest there is",
// never "the newest we know of", because the device resolves that for itself when it downloads. This hint is
// where the panel keeps what it no longer says out loud — what an update touches, and what it leaves alone.
const upgrade = (): AgentAction<DeviceAgentOp> => ({
    op: `upgrade`,
    label: t(`sandbox.deviceAgent.updateAgent`),
    hint: t(`sandbox.deviceAgent.fetchesNewestAgentOnto`),
});

// Update leads: it is the errand people come to this group for, and it restarts the loop on its way past,
// which makes Restart the narrower of the two rather than the first thing to try.
const ACTIONS: readonly AgentAction<DeviceAgentOp>[] = [upgrade(), restartAgent()];

// Every verb here travels over the device's own outbound socket, so a machine not holding one gets the
// sentence without the controls. Wider than the container verbs' `commandable`, by one case: a device
// holding a socket while sending no report is usually one whose agent predates machine reports, which is
// exactly the machine an update fixes, and the one this view used to answer with a command to go and type.
// An agent too old to have the flow at all refuses in its own words, which is an answer either way.
const reachable = (device: Device): boolean =>
    device.hostId !== undefined && device.online === true && (device.gap === undefined || device.gap === `unreported`);

// Why this machine has no buttons, as the shortest true clause plus the long form on hover. Each gap the
// concerns strip also covers is named here in a few words rather than restated in full.
const gapBlocked = (): Record<NonNullable<Device[`gap`]>, AgentNote> => ({
    offline: { text: `Not answering — nothing can run on it.`, icon: `moon` },
    "scope-off": {
        text: `"Run commands" is off.`,
        icon: `lock`,
        hint: t(`sandbox.deviceAgent.runningAnythingOnDevice`),
    },
    "no-agent": { text: `No agent to update.`, icon: `lock`, hint: t(`sandbox.deviceAgent.capabilityCardHandsOut`) },
    // Never reached: an unreported device keeps its buttons (see `reachable`). Present so the map stays total.
    unreported: { text: `Hasn't reported yet.`, icon: `moon`, hint: t(`sandbox.deviceAgent.nothingHereKnowsWhat`) },
});

const syncOnly = (): AgentNote => ({
    text: `Enrolled for syncing only.`,
    icon: `lock`,
    hint: t(`sandbox.deviceAgent.updatingAgentRunsCommand`),
});

// The one case with no errand in it, and the only line on screen while it holds: the concerns strip stands down
// for a socket this young (deviceAttention.ts), so this is what explains the missing buttons.
const reconnecting = (): AgentNote => ({
    text: `Reconnecting — its buttons come back with it.`,
    icon: `sync`,
    hint: t(`sandbox.deviceAgent.socketDroppedMomentAgo`),
});

const blockedWhy = (device: Device, readAt: number): AgentNote | undefined => {
    if (reachable(device)) {
        return undefined;
    }
    if (device.hostId === undefined) {
        return syncOnly();
    }
    if (deviceReconnecting(device, readAt)) {
        return reconnecting();
    }
    return device.gap === undefined ? gapBlocked().offline : gapBlocked()[device.gap];
};

// Two states only a registry can be in, ahead of the loop's own three (agentLoopState).
const stateOf = (row: DeviceRow, readAt: number): AgentPanel[`state`] => {
    // A loop whose socket dropped seconds ago reported perfectly well a moment before; the reading is missing
    // because the machine is between connections, which is the badge's own word for it rather than the absence.
    if (deviceReconnecting(row.device, readAt)) {
        return { word: `reconnecting`, variant: `neutral` };
    }
    // A machine that has never reported has an agent this sandbox has only ever been dialled by; its
    // version is known from the hello frame, its loop is not.
    if (row.agent === undefined) {
        return { word: `not reported`, variant: `neutral` };
    }
    return agentLoopState(row.agent);
};

// Judged on the installed build, since that is what an update downloads over; a device whose only problem is
// a stale loop is agentSkewNote's, not this one's.
const publishedNote = (row: DeviceRow, latest: string): AgentNote => {
    const held = row.device.report?.agent.installed ?? row.chip?.version;
    return {
        text: held === undefined ? `Agent ${latest} has been published.` : `Agent ${latest} has been published; this device has ${held}.`,
        tone: `info`,
        hint: t(`sandbox.deviceAgent.updateAgentFetchesInstalls`),
    };
};

// The quiet line that makes an always-present Update button legible: what that button is for on a device
// asking for nothing. Never carries a tone — there is no errand in it. The hint's clause naming the button
// is dropped where there is no button, rather than pointing at a control this machine doesn't get.
const standingNote = (latest: string | undefined, offered: boolean): AgentNote => {
    if (latest !== undefined) {
        return { text: `Newest agent this sandbox knows of.`, icon: `check-circle` };
    }
    const cannotTell = `This sandbox doesn't know which agent release is newest, so it can't tell you whether this one is behind.`;
    return {
        text: `Newest release unknown.`,
        icon: `question-circle`,
        hint: offered ? `${cannotTell} Update fetches the newest there is.` : cannotTell,
    };
};

// One sentence per distinct errand, worst first; a stale loop and a published release can both be true at
// once (replaced but not restarted, and something newer out since), so neither hides the other. A settled
// agent still gets one line, so the buttons beside it are never unexplained.
const notesOf = (row: DeviceRow, latest: string | undefined, offered: boolean): AgentNote[] => {
    const behind = latest !== undefined && agentBehind(row.device, latest);
    const notes = [agentLoopNote(row.agent), agentSkewNote(row.agent?.staleBuild), behind ? publishedNote(row, latest) : undefined].filter(
        (note) => note !== undefined,
    );
    return notes.length === 0 ? [standingNote(latest, offered)] : notes;
};

// Nothing to say and nothing to do: a machine with no version from either door and no command door is one
// this group would draw an empty heading for.
export const deviceAgentPanel = (row: DeviceRow, latest: string | undefined, readAt: number): DeviceAgentPanel | undefined => {
    const { device } = row;
    const version = row.chip?.version;
    if (version === undefined && device.hostId === undefined) {
        return undefined;
    }
    const offered = reachable(device);
    const pid = row.agent?.pid;
    return {
        version,
        state: stateOf(row, readAt),
        facts: pid === undefined ? [] : [`pid ${pid}`],
        notes: notesOf(row, latest, offered),
        actions: offered ? ACTIONS : [],
        blocked: blockedWhy(device, readAt),
    };
};
