import type { Device, DeviceAgentOp } from "@intentic/sandbox-contract";
import type { IconName, StatusVariant } from "@intentic/ui";
import type { NoticeTone } from "@intentic/ui/notice";
import { agentBehind, deviceReconnecting } from "./deviceFacts";
import type { DeviceRow, RowAgent } from "./deviceRows";

// The agent running on one device, as the panel that both states it and changes it: the build its loop
// serves, whether that is the build on disk and the build published, and the two verbs that move either.
// Pure, so every rule below is checkable without mounting anything (deviceAgent.test.ts).

// Both verbs are offered whenever the machine can hear them, not only when this sandbox has decided
// something is wrong. An update gated on a registry comparison is no update at all on a dev build, on a
// sandbox that never reached the registry, or on an agent published since this sandbox last looked — and
// each of those is a walk to the machine to type `intentic-machine upgrade` by hand.

export interface AgentAction {
    readonly op: DeviceAgentOp;
    readonly label: string;
    readonly hint: string;
}

export interface AgentNote {
    readonly text: string;
    /** Absent for a remark that is merely true; a tone makes it a notice with an errand behind it. */
    readonly tone?: NoticeTone;
    /** The glyph for an untoned remark; a toned one wears its notice's own. */
    readonly icon?: IconName;
    /** The sentence the line was cut down from, on hover: detail nobody has to read to act. */
    readonly hint?: string;
}

// What this one process carries, as the row's description: three glyphs, not a sentence about them.
export const AGENT_DUTIES: readonly { readonly icon: IconName; readonly label: string }[] = [
    { icon: `folder`, label: `Folders` },
    { icon: `ports`, label: `Ports` },
    { icon: `terminal`, label: `Commands` },
];

export interface AgentPanel {
    /** The build the loop serves, or the best-known version; absent when no door has named one. */
    readonly version: string | undefined;
    /** The loop's own state, in the badge's word and colour. */
    readonly state: { readonly word: string; readonly variant: StatusVariant };
    /** Facts too small for a sentence, in the meta cluster's ink. */
    readonly facts: readonly string[];
    /** In falling severity; a settled agent still gets one, so the buttons beside it are not unexplained. */
    readonly notes: readonly AgentNote[];
    /** Empty on a machine no click could reach, where `blocked` says why instead. */
    readonly actions: readonly AgentAction[];
    readonly blocked: AgentNote | undefined;
}

const RESTART: AgentAction = {
    op: `restart`,
    label: `Restart agent`,
    hint: `Stops and starts this device's agent loop. Nothing is downloaded — the build already installed there is the one that comes up.`,
};

// Worded for a current agent as much as a stale one, since it is offered on both: "the newest there is",
// never "the newest we know of", because the device resolves that for itself when it downloads. This hint is
// where the panel keeps what it no longer says out loud — what an update touches, and what it leaves alone.
const UPGRADE: AgentAction = {
    op: `upgrade`,
    label: `Update agent`,
    hint: `Fetches the newest agent onto this device, installs it, and restarts its loop — the one process this sandbox reaches the device through. Safe on an agent that is already current; its folders, pairings and mirrored ports are untouched either way.`,
};

// Update leads: it is the errand people come to this group for, and it restarts the loop on its way past,
// which makes Restart the narrower of the two rather than the first thing to try.
const ACTIONS: readonly AgentAction[] = [UPGRADE, RESTART];

// Every verb here travels over the device's own outbound socket, so a machine not holding one gets the
// sentence without the controls. Wider than the container verbs' `commandable`, by one case: a device
// holding a socket while sending no report is usually one whose agent predates machine reports, which is
// exactly the machine an update fixes, and the one this view used to answer with a command to go and type.
// An agent too old to have the flow at all refuses in its own words, which is an answer either way.
const reachable = (device: Device): boolean =>
    device.hostId !== undefined && device.online === true && (device.gap === undefined || device.gap === `unreported`);

// Why this machine has no buttons, as the shortest true clause plus the long form on hover. Each gap the
// concerns strip also covers is named here in a few words rather than restated in full.
const GAP_BLOCKED: Record<NonNullable<Device[`gap`]>, AgentNote> = {
    offline: { text: `Not answering — nothing can run on it.`, icon: `moon` },
    "scope-off": {
        text: `"Run commands" is off.`,
        icon: `lock`,
        hint: `Running anything on this device needs "Run commands" on its capability card, and that switch is off.`,
    },
    "no-agent": { text: `No agent to update.`, icon: `lock`, hint: `Its capability card hands out the command that installs one.` },
    // Never reached: an unreported device keeps its buttons (see `reachable`). Present so the map stays total.
    unreported: { text: `Hasn't reported yet.`, icon: `moon`, hint: `Nothing here knows what this device's agent is.` },
};

const SYNC_ONLY: AgentNote = {
    text: `Enrolled for syncing only.`,
    icon: `lock`,
    hint: `Updating its agent runs a command on it, which needs the machine connected as a device, not just syncing folders and ports.`,
};

// The one case with no errand in it, and the only line on screen while it holds: the concerns strip stands down
// for a socket this young (deviceAttention.ts), so this is what explains the missing buttons.
const RECONNECTING: AgentNote = {
    text: `Reconnecting — its buttons come back with it.`,
    icon: `sync`,
    hint: `Its socket dropped a moment ago, which is what restarting an agent does. A fresh loop dials back in by itself, and nothing can be run on the machine until it has.`,
};

const blockedWhy = (device: Device, readAt: number): AgentNote | undefined => {
    if (reachable(device)) {
        return undefined;
    }
    if (device.hostId === undefined) {
        return SYNC_ONLY;
    }
    if (deviceReconnecting(device, readAt)) {
        return RECONNECTING;
    }
    return device.gap === undefined ? GAP_BLOCKED.offline : GAP_BLOCKED[device.gap];
};

const stateOf = (row: DeviceRow, readAt: number): AgentPanel[`state`] => {
    const agent = row.agent;
    // A loop whose socket dropped seconds ago reported perfectly well a moment before; the reading is missing
    // because the machine is between connections, which is the badge's own word for it rather than the absence.
    if (deviceReconnecting(row.device, readAt)) {
        return { word: `reconnecting`, variant: `neutral` };
    }
    // A machine that has never reported has an agent this sandbox has only ever been dialled by; its
    // version is known from the hello frame, its loop is not.
    if (agent === undefined) {
        return { word: `not reported`, variant: `neutral` };
    }
    if (!agent.running) {
        return { word: `stopped`, variant: `warning` };
    }
    return agent.stalled ? { word: `stalled`, variant: `warning` } : { word: `running`, variant: `success` };
};

// A dead loop and a stalled one are the same errand — bring the loop back — so at most one of them is said.
const loopNote = (agent: RowAgent | undefined): AgentNote | undefined => {
    if (agent === undefined) {
        return undefined;
    }
    if (!agent.running) {
        return { text: `Loop stopped — nothing reaches its folders or ports.`, tone: `warning` };
    }
    return agent.stalled
        ? {
              text: `Loop stalled — what is below may be out of date.`,
              tone: `warning`,
              hint: `Its agent is alive but has stopped making rounds, so this sandbox's picture of its folders and ports is as old as the last one.`,
          }
        : undefined;
};

// A separate errand from the loop's own state: the file on disk is newer than what the process runs, which a
// restart alone closes and a download would not.
const skewNote = (skew: RowAgent[`staleBuild`]): AgentNote | undefined =>
    skew === undefined
        ? undefined
        : {
              text:
                  skew.running === undefined
                      ? `Serving a build older than the ${skew.installed} installed — a restart picks it up.`
                      : `Serving ${skew.running}, ${skew.installed} installed — a restart picks it up.`,
              tone: `warning`,
              hint: `A loop keeps the build it started with until it restarts, so replacing the file on disk changes nothing on its own.`,
          };

// Judged on the installed build, since that is what an update downloads over; a device whose only problem is
// a stale loop is skewNote's, not this one's.
const publishedNote = (row: DeviceRow, latest: string): AgentNote => {
    const held = row.device.report?.agent.installed ?? row.chip?.version;
    return {
        text: held === undefined ? `Agent ${latest} has been published.` : `Agent ${latest} has been published; this device has ${held}.`,
        tone: `info`,
        hint: `Update agent fetches it, installs it, and restarts the loop on that device.`,
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
    const notes = [loopNote(row.agent), skewNote(row.agent?.staleBuild), behind ? publishedNote(row, latest) : undefined].filter(
        (note) => note !== undefined,
    );
    return notes.length === 0 ? [standingNote(latest, offered)] : notes;
};

// Nothing to say and nothing to do: a machine with no version from either door and no command door is one
// this group would draw an empty heading for.
export const deviceAgentPanel = (row: DeviceRow, latest: string | undefined, readAt: number): AgentPanel | undefined => {
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
