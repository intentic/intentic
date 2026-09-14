import type { Device, DeviceAgentOp } from "@intentic/sandbox-contract";
import type { StatusVariant } from "@intentic/ui";
import type { NoticeTone } from "@intentic/ui/notice";
import { agentBehind } from "./deviceFacts";
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
}

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
    readonly blocked: string | undefined;
}

const RESTART: AgentAction = {
    op: `restart`,
    label: `Restart agent`,
    hint: `Stop and start this device's agent loop. Nothing is downloaded, and the build already installed there is the one that comes up.`,
};

// Worded for a current agent as much as a stale one, since it is offered on both: "the newest there is",
// never "the newest we know of", because the device resolves that for itself when it downloads.
const UPGRADE: AgentAction = {
    op: `upgrade`,
    label: `Update agent`,
    hint: `Fetch the newest agent onto this device, install it, and restart its loop. Safe on one that is already current, and its folders, pairings and mirrored ports are untouched either way.`,
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

// Why this machine has no buttons, in terms of what would have to change. Each gap the concerns strip also
// covers is named in one clause here rather than restated in full.
const GAP_BLOCKED: Record<NonNullable<Device[`gap`]>, string> = {
    offline: `This device isn't answering right now, so nothing can be run on it.`,
    "scope-off": `Running anything on this device needs "Run commands" on its capability card, and that switch is off.`,
    "no-agent": `This device has no agent to update. Its capability card hands out the command that installs one.`,
    // Never reached: an unreported device keeps its buttons (see `reachable`). Present so the map stays total.
    unreported: `This device hasn't reported yet, so nothing here knows what its agent is.`,
};

const blockedWhy = (device: Device): string | undefined => {
    if (reachable(device)) {
        return undefined;
    }
    if (device.hostId === undefined) {
        return `This device is enrolled for syncing only. Updating its agent runs a command on it, which needs it connected as a device.`;
    }
    return device.gap === undefined ? GAP_BLOCKED.offline : GAP_BLOCKED[device.gap];
};

const stateOf = (row: DeviceRow): AgentPanel[`state`] => {
    const agent = row.agent;
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
        return { text: `Its agent isn't running, so nothing is reaching this device's folders or ports.`, tone: `warning` };
    }
    return agent.stalled
        ? { text: `Its agent is alive but has stopped making rounds, so the folders and ports below may be out of date.`, tone: `warning` }
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
                      ? `It is serving a build older than the ${skew.installed} installed there: a loop keeps the build it started with until it restarts.`
                      : `It is serving agent ${skew.running} while ${skew.installed} is installed there: a loop keeps the build it started with until it restarts.`,
              tone: `warning`,
          };

// Judged on the installed build, since that is what an update downloads over; a device whose only problem is
// a stale loop is skewNote's, not this one's.
const publishedNote = (row: DeviceRow, latest: string): AgentNote => {
    const held = row.device.report?.agent.installed ?? row.chip?.version;
    return {
        text: held === undefined ? `Agent ${latest} has been published.` : `Agent ${latest} has been published; this device has ${held}.`,
        tone: `info`,
    };
};

// The quiet line that makes an always-present Update button legible: what that button is for on a device
// asking for nothing. Never carries a tone — there is no errand in it. The clause naming the button is
// dropped where there is no button, rather than pointing at a control this machine doesn't get.
const standingNote = (latest: string | undefined, offered: boolean): AgentNote => {
    if (latest !== undefined) {
        return { text: `This is the newest agent this sandbox knows of.` };
    }
    const cannotTell = `This sandbox doesn't know which agent release is newest, so it can't tell you whether this one is behind.`;
    return { text: offered ? `${cannotTell} Update fetches the newest there is.` : cannotTell };
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
export const deviceAgentPanel = (row: DeviceRow, latest: string | undefined): AgentPanel | undefined => {
    const { device } = row;
    const version = row.chip?.version;
    if (version === undefined && device.hostId === undefined) {
        return undefined;
    }
    const offered = reachable(device);
    const pid = row.agent?.pid;
    return {
        version,
        state: stateOf(row),
        facts: pid === undefined ? [] : [`pid ${pid}`],
        notes: notesOf(row, latest, offered),
        actions: offered ? ACTIONS : [],
        blocked: blockedWhy(device),
    };
};
