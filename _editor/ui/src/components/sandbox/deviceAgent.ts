// One device's agent as the panel that both states it and changes it: the build its loop serves, what that
// loop wants, and the verbs that move it. DOM-free, so both callers (the web Devices tab, which reads a
// daemon's device registry, and the desktop app, which asks the machine it runs on) build the same object
// from their own facts and hand it to <DeviceAgentGroup>.

import type { IconName } from "../../icons/iconSets.js";
import type { StatusVariant } from "../feedback/statusBadge.js";
import type { NoticeTone } from "../feedback/notice.js";
import { t } from "../../i18n/index.js";

// The agent, in the three states a reader can act on. `stalled` is decided by the caller (see
// `agentStalled` in the sandbox contract), so browser and terminal can't disagree about one machine.
export interface DeviceAgentState {
    running: boolean;
    stalled?: boolean | undefined;
    pid?: number | undefined;
    // The build serving now, and the newer one installed beside it, when a machine hasn't picked up an update yet.
    // Optional: a loop old enough to predate the build stamp reports no build at all, while still running.
    staleBuild?: { readonly running: string | undefined; readonly installed: string } | undefined;
}

// Generic over the op so each caller keeps its own union (the contract's `DeviceAgentOp` in web, a narrower
// one in an app that can only restart); the kit itself never has to know what ops exist.
export interface AgentAction<Op extends string = string> {
    readonly op: Op;
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
export const agentDuties = (): readonly { readonly icon: IconName; readonly label: string }[] => [
    { icon: `folder`, label: t(`ui.deviceAgent.folders`) },
    { icon: `ports`, label: t(`ui.deviceAgent.ports`) },
    { icon: `terminal`, label: t(`ui.deviceAgent.commands`) },
];

/** The sentence the duty strip replaced, kept on hover where a reader can still reach for it. */
export const agentCarries = (machine: string): string => `Everything this sandbox does on ${machine} goes through this one process.`;

export interface AgentPanel<Op extends string = string> {
    /** The build the loop serves, or the best-known version; absent when no door has named one. */
    readonly version: string | undefined;
    /** The loop's own state, in the badge's word and colour. */
    readonly state: { readonly word: string; readonly variant: StatusVariant };
    /** Facts too small for a sentence, in the meta cluster's ink. */
    readonly facts: readonly string[];
    /** In falling severity; a settled agent still gets one, so the buttons beside it are not unexplained. */
    readonly notes: readonly AgentNote[];
    /** Empty on a machine no click could reach, where `blocked` says why instead. */
    readonly actions: readonly AgentAction<Op>[];
    readonly blocked: AgentNote | undefined;
}

// The panel's lines in reading order: what the agent wants, then why it has no buttons. One list, so the two
// render as one column of short lines instead of two blocks that happen to sit together.
export const agentLines = (panel: AgentPanel): readonly AgentNote[] => [...panel.notes, ...(panel.blocked === undefined ? [] : [panel.blocked])];

// Restarting is the one verb every caller has: it runs on the machine's own installed build and downloads
// nothing, so a caller with any way to that machine can offer it.
export const restartAgent = (): AgentAction<`restart`> => ({
    op: `restart`,
    label: t(`ui.deviceAgent.restartAgent`),
    hint: t(`ui.deviceAgent.stopsStartsDevicesAgent`),
});

/** The badge's word for an agent that has reported; a caller states a device it hasn't heard from itself. */
export const agentLoopState = (agent: DeviceAgentState): AgentPanel[`state`] => {
    if (!agent.running) {
        return { word: `stopped`, variant: `warning` };
    }
    return agent.stalled === true ? { word: `stalled`, variant: `warning` } : { word: `running`, variant: `success` };
};

// A dead loop and a stalled one are the same errand — bring the loop back — so at most one of them is said.
export const agentLoopNote = (agent: DeviceAgentState | undefined): AgentNote | undefined => {
    if (agent === undefined) {
        return undefined;
    }
    if (!agent.running) {
        return { text: `Loop stopped — nothing reaches its folders or ports.`, tone: `warning` };
    }
    return agent.stalled === true
        ? {
              text: `Loop stalled — what is below may be out of date.`,
              tone: `warning`,
              hint: t(`ui.deviceAgent.agentAliveStoppedMaking`),
          }
        : undefined;
};

// A separate errand from the loop's own state: the file on disk is newer than what the process runs, which a
// restart alone closes and a download would not.
export const agentSkewNote = (skew: DeviceAgentState[`staleBuild`]): AgentNote | undefined =>
    skew === undefined
        ? undefined
        : {
              text:
                  skew.running === undefined
                      ? `Serving a build older than the ${skew.installed} installed — a restart picks it up.`
                      : `Serving ${skew.running}, ${skew.installed} installed — a restart picks it up.`,
              tone: `warning`,
              hint: t(`ui.deviceAgent.loopKeepsBuildStarted`),
          };
