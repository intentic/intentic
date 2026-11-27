import { errorMessage } from "@intentic/base/errors";
import type { DeviceAgentFlow, DeviceFlowLine } from "@intentic/sandbox-contract/schemas/devices";
import {
    fixablePowerFindings,
    type HostPower,
    type HostPowerFinding,
    pauseUntilFor,
    POWER_FINDING,
    POWER_REMEDY,
    restartBlocks,
} from "@intentic/sandbox-contract/schemas/host-power";
import { DEVICE_FEATURE_POWER, DEVICE_FEATURE_POWER_RESTART, type DeviceFacts, deviceSupports, parseHostConnection } from "@intentic/sandbox-contract/schemas/hosts";
import type { HostPowerNeed, Need, NeedAnswer, NeedSubject } from "@intentic/sandbox-contract/schemas/needs";
import type { Answered, Met, NeedKindHandler, Resolved } from "../need-kinds.js";

/* The computer this sandbox runs on would sleep through work booked on it (2026-11-22, hosts/power/host-power.ts). rog's power
   plan slept it five hours after its owner's last keypress; every sandbox on it froze until the lid was opened, a send
   booked for 07:10 went out at 10:01, and nobody had been told. The owner's call: nothing here holds the computer awake
   by itself. The sandbox says so on a card the moment such work is booked, and the owner's yes changes the computer's
   own settings, through the same agent op the Devices view's buttons run (`power-stay-on`), on mains power only.

   The daemon raises this card itself (hosts/power/host-power.ts `checkHostPowerFor`); no agent asks for it, and its agent never
   hears how it ended (`tellsAgent`), since a woken turn would run the booked work early.

   (2026-11-27) A Windows Update restart used to be a note the card could only put away. Its finding now says what answers
   it (`offers`, POWER_REMEDY), and the yes runs the one the person chose (the approve answer's `remedy`) after stay-on:
   Windows Update paused until the end of the restart window the booked work falls in (`pauseUntilFor`), or the PC's start
   before sign-in, which brings the sandboxes on intentic's engine back by themselves. The card is met once the restart,
   as the computer says it now, no longer stops the booked work (`restartBlocks`), whichever way that came about. */

// How much of what the computer printed the card's result keeps: the last lines, which say what changed.
const RESULT_LINES = 6;
const RESULT_CHARS = 600;

export interface HostPowerNeedDeps {
    // The computer's facts as the hub holds them now, never a pull: a check pass must cost no round trip to a laptop
    // that may be asleep.
    readonly facts: (device: string) => DeviceFacts | undefined;
    readonly online: (device: string) => boolean;
    // The agent op, run the way the Devices view's agent buttons run it (hosts/device-reports.ts `runDeviceAgentFlow`).
    readonly runAgentFlow: (device: string, flow: DeviceAgentFlow) => AsyncIterable<DeviceFlowLine>;
    // Asks the computer to describe itself again within a short deadline; it keeps the last answer when it cannot.
    readonly refresh: (device: string) => Promise<void>;
    readonly now?: () => number;
}

type Remedy = NonNullable<Extract<NeedAnswer, { kind: "approve" }>["remedy"]>;

// The card's Windows Update restart, where its finding offers an answer. Pure.
const restartOf = (subject: Pick<HostPowerNeed, "findings">): HostPowerFinding | undefined =>
    subject.findings.find((finding) => finding.id === POWER_FINDING.updateRestart && (finding.offers?.length ?? 0) > 0);

/** The answer to the restart a yes runs: the one asked for, else the pause, of those the finding offers. Pure. */
const chosenRemedy = (finding: HostPowerFinding | undefined, asked: Remedy | undefined): Remedy | undefined => {
    const wanted = asked ?? POWER_REMEDY.pauseUpdates;
    return finding?.offers?.includes(wanted) === true ? wanted : undefined;
};

// Whether the restart, as the computer says it now, no longer stops the card's booked work: gone, paused past it, or the
// sandboxes starting with the computer. Undefined where the card holds no restart with an answer. Pure.
const restartAnswered = (subject: Pick<HostPowerNeed, "findings" | "dueAt">, power: HostPower, now: number): boolean | undefined => {
    if (restartOf(subject) === undefined) {
        return undefined;
    }
    const fresh = power.findings.find((finding) => finding.id === POWER_FINDING.updateRestart);
    if (fresh === undefined) {
        return true;
    }
    if (subject.dueAt === undefined) {
        return fresh.comesBack === "boot" || (fresh.pausedUntil ?? 0) > now;
    }
    return !restartBlocks(fresh, power.utcOffsetMinutes, now, subject.dueAt);
};

// The computer's own name, as the owner calls it: the card a connection key belongs to. Pure.
const hostPowerDeviceName = (device: string): string => parseHostConnection(device).card;

// The findings a person can make go away, whose going away the card watches for: the ones the agent's op changes, or,
// where the card holds none of those, the ones a person runs a command for (a Linux suspend that needs root). Battery
// sleep and an update restart are reported, never changed, so they never close a card by themselves. Pure.
const watched = (subject: Pick<HostPowerNeed, "findings">): { readonly ids: readonly string[]; readonly fixable: boolean } => {
    const fixable = fixablePowerFindings(subject);
    return fixable.length > 0
        ? { ids: fixable.map((finding) => finding.id), fixable: true }
        : { ids: subject.findings.filter((finding) => finding.command !== undefined).map((finding) => finding.id), fixable: false };
};

// Whether the computer's facts as held now no longer show anything the card watches: the owner changed it by hand, or
// the op did, and a restart with an answer no longer stops the work. Undefined when nothing can say (no power facts,
// nothing watched). Pure.
const hostPowerFixed = (subject: Pick<HostPowerNeed, "findings" | "dueAt">, facts: DeviceFacts | undefined, now: number): boolean | undefined => {
    const power = facts?.power;
    if (power === undefined) {
        return undefined;
    }
    const { ids, fixable } = watched(subject);
    const still = new Set((fixable ? fixablePowerFindings(power) : power.findings).map((finding) => finding.id));
    const parts = [...(ids.length === 0 ? [] : [!ids.some((id) => still.has(id))]), restartAnswered(subject, power, now)].filter(
        (part): part is boolean => part !== undefined,
    );
    return parts.length === 0 ? undefined : parts.every(Boolean);
};

// What the card says changed: the computer's own last lines, on one line, cut to a card's length. Pure.
export const changedOn = (name: string, lines: readonly string[], result: string | undefined): string => {
    const said = lines
        .map((line) => line.trim())
        .filter((line) => line !== "")
        .slice(-RESULT_LINES)
        .join(" ");
    const what = said === "" ? (result?.trim() ?? "") : said;
    const cut = what.length > RESULT_CHARS ? `${what.slice(0, RESULT_CHARS - 1)}…` : what;
    return cut === "" ? `${name}'s power settings were changed on mains power.` : `Changed on ${name}: ${cut}`;
};

type Refusal = { readonly refused: string };
type Ran = Refusal | { readonly lines: readonly string[]; readonly result: string | undefined };

// One op, its frames read through: an `error` frame is the computer refusing, in its own words; a `result` frame is it
// saying it finished; neither is the connection gone before it said (runDeviceAgentFlow's own line).
const runFlow = async (deps: HostPowerNeedDeps, device: string, flow: DeviceAgentFlow): Promise<Ran> => {
    const lines: string[] = [];
    let result: string | undefined;
    try {
        for await (const frame of deps.runAgentFlow(device, flow)) {
            if (frame.kind === "error") {
                return { refused: frame.message };
            }
            if (frame.kind === "line") {
                lines.push(frame.text);
            } else {
                result = frame.message;
            }
        }
    } catch (error) {
        // The door's own refusal (the computer dropped between the check above and the call): said as it is.
        return { refused: errorMessage(error) };
    }
    return { lines, result };
};

// The words for an answer a card did not offer.
const REMEDY_WORDS = {
    "update-pause": "pausing Windows Update",
    "before-sign-in": "starting its sandboxes before anyone signs in",
} as const satisfies Readonly<Record<Remedy, string>>;

// The op that answers the restart as chosen: the start before sign-in, or the pause until the end of the restart window
// the booked work falls in. Pure.
const remedyFlow = (subject: HostPowerNeed, restart: HostPowerFinding, remedy: Remedy, facts: DeviceFacts | undefined, at: number): DeviceAgentFlow | Refusal => {
    if (remedy === POWER_REMEDY.beforeSignIn) {
        return { op: "before-sign-in" };
    }
    const until = pauseUntilFor(restart, facts?.power?.utcOffsetMinutes ?? subject.utcOffsetMinutes ?? 0, at, subject.dueAt ?? at);
    return until === undefined
        ? { refused: `The booked work is further off than Windows lets updates be paused (five weeks): nothing was changed on ${hostPowerDeviceName(subject.device)}.` }
        : { op: "update-pause", until };
};

/** The ops a yes runs, in order: stay-on where the card holds what it changes, then the chosen answer to the restart. Pure. */
export const flowsFor = (subject: HostPowerNeed, asked: Remedy | undefined, facts: DeviceFacts | undefined, at: number): DeviceAgentFlow[] | Refusal => {
    const name = hostPowerDeviceName(subject.device);
    const restart = restartOf(subject);
    const remedy = chosenRemedy(restart, asked);
    if (asked !== undefined && remedy === undefined) {
        return { refused: `This card does not offer ${REMEDY_WORDS[asked]} on ${name}.` };
    }
    const flows: DeviceAgentFlow[] = fixablePowerFindings(subject).length > 0 ? [{ op: "power-stay-on" }] : [];
    if (restart === undefined || remedy === undefined) {
        return flows.length > 0 ? flows : { refused: `Nothing on this card is a setting ${name}'s agent can change: what it says is done on ${name} itself.` };
    }
    if (!deviceSupports(facts, DEVICE_FEATURE_POWER_RESTART)) {
        return { refused: `${name}'s agent is older than this: update it from the Devices view, then press again.` };
    }
    const answer = remedyFlow(subject, restart, remedy, facts, at);
    return "refused" in answer ? answer : [...flows, answer];
};

// The yes: each op in turn, then the computer read again.
const approve = async (deps: HostPowerNeedDeps, now: () => number, subject: HostPowerNeed, asked: Remedy | undefined): Promise<Answered> => {
    const name = hostPowerDeviceName(subject.device);
    if (!deps.online(subject.device)) {
        return { refused: `${name} is not connected right now, so nothing can change its settings: wake it or open its lid, then press again.` };
    }
    if (!deviceSupports(deps.facts(subject.device), DEVICE_FEATURE_POWER)) {
        return { refused: `${name}'s agent is older than this: update it from the Devices view, then press again.` };
    }
    const flows = flowsFor(subject, asked, deps.facts(subject.device), now());
    if (!Array.isArray(flows)) {
        return flows;
    }
    const lines: string[] = [];
    let result: string | undefined;
    let finished = true;
    for (const flow of flows) {
        // one after another: each op changes the same computer's settings, and stay-on's lines read first
        const ran = await runFlow(deps, subject.device, flow);
        if ("refused" in ran) {
            return { refused: ran.refused };
        }
        lines.push(...ran.lines);
        result = ran.result ?? result;
        finished &&= ran.result !== undefined;
    }
    // Read again, so the card's own check and the Devices view both see the settings as they are now. A computer that
    // does not answer in time keeps what it said last, which is no reason to fail a change it already made.
    // allow(silent-catch): a refresh that times out leaves the last facts, which the check below reads as they are
    await deps.refresh(subject.device).catch(() => undefined);
    // A run that ended without saying it finished is only a change when the computer's fresh facts show it.
    if (!finished && hostPowerFixed(subject, deps.facts(subject.device), now()) !== true) {
        return { refused: `${name} stopped answering before it said its settings changed: press again once it is back.` };
    }
    return { status: "met", result: changedOn(name, lines, result), use: [] };
};

export const hostPowerNeed = (deps: HostPowerNeedDeps): NeedKindHandler => {
    const now = deps.now ?? Date.now;
    const subjectOf = (need: Need): HostPowerNeed | undefined => (need.subject.kind === "host-power" ? need.subject : undefined);

    return {
        // Raised by the sandbox when work is booked, never asked for: an agent's ask cannot name this kind at all
        // (NeedAskSchema), and this answers one that somehow did.
        resolve: async (): Promise<Resolved> => ({
            kind: "refused",
            code: "invalid",
            message: "A power card is raised by the sandbox itself when work is booked, never asked for.",
        }),
        // Met when the computer's settings, as already held, no longer show what the card asked to change: the owner
        // changed them by hand, or from the Devices view.
        check: async (need): Promise<Met | undefined> => {
            const subject = subjectOf(need);
            if (subject === undefined || hostPowerFixed(subject, deps.facts(subject.device), now()) !== true) {
                return undefined;
            }
            return { result: `${hostPowerDeviceName(subject.device)}'s settings no longer stop work left running on it.`, use: [] };
        },
        answer: async (need, answer) => {
            const subject = subjectOf(need);
            if (subject === undefined || answer.kind !== "approve") {
                return { refused: "A power card is answered by approving the change, or declined." };
            }
            return approve(deps, now, subject, answer.remedy);
        },
        // The floor of the door that runs the same op from the Devices view (devices.routes.ts `runDeviceAgentFlow`): a
        // person signed in as a maintainer or the owner, never a machine credential the answer route admits. Held for a
        // decline too, since a decline keeps the card from coming back for a week (hosts/power/host-power.ts).
        mayAnswer: (_need, by) =>
            by.maintainer === true ? undefined : "Only a sandbox maintainer, signed in, can change a connected computer's power settings or dismiss this.",
        nextTurn: () => false,
        // One card per computer: its settings are the computer's, whichever booking found them.
        key: (subject: NeedSubject) => (subject.kind === "host-power" ? subject.device : ""),
        tellsAgent: false,
    };
};
