import { agentBuildSkew, agentStalled, type Device, type DeviceAgentOp, machinesOf } from "@intentic/sandbox-contract";
import type { NoticeModel } from "@intentic/ui";
import { shallowRef } from "vue";
import { t } from "@intentic/ui/i18n";
import { activeSandboxId } from "../../../../lib/activeSandbox";
import { type AgentRun, agentRunTitle, type LinksAsked } from "./agentRun";

// WORK IN FLIGHT ON A MACHINE, PAST THE PAGE THAT STARTED IT. A device page is mounted while it is on screen and not a
// moment longer, and what it starts takes minutes: an agent update detaches on the machine and its call returns in
// seconds, while the agent coming back on the new build is the rest of the wait. Kept on the page, all of that ended
// the moment the reader went back to the board — no row turned, the Devices row stopped turning, and coming back to
// the page offered Update again over an update still running. So the ledger is module state, like hubWork.ts: every
// run stamped with the sandbox it began on, retired by its own end, read by the board's cards, the hub's Devices row,
// the rail's Devices tile and the page itself.
//
// Two kinds of run. A MARK is a call: a container verb, a sync switch, a removal, a batch; it ends when its promise
// settles. An AGENT RUN outlives its call: the answer is the machine's agent coming back, which only a reading can show
// (settleAgentRuns, fed by watchDeviceReturns). Its record also carries what the page's strip draws (agentRun.ts), so
// the strip is there again when the page is.

/** What one press is doing to one machine, in the two places it is said. */
export interface DeviceWorkMark {
    /** The machine's key (MachineRow.key): what the board's card and the page's URL go by. */
    readonly machine: string;
    /** The sandboxes it acts on, so their lines turn on the board as their rows do on the page. */
    readonly sandboxes?: readonly string[];
    /** On the machine's own card, which already names the machine: "Stopping work-abc". */
    readonly doing: string;
    /** Anywhere else (the hub's Devices row, the rail's tile), so it names the machine. */
    readonly what: string;
}

interface Mark extends DeviceWorkMark {
    readonly id: number;
    readonly sandboxId: string | undefined;
}

/** A refusal as the strip draws it: the machine's own words, and the same act as a line to type there. */
export interface AgentFailure {
    readonly notice: NoticeModel;
    readonly command?: string | undefined;
}

/** One environment's part in one press of an agent verb. */
interface AgentRecord {
    readonly sandboxId: string | undefined;
    readonly device: string;
    readonly machine: string;
    /** The press said away from the machine's card (the hub's Devices row, the rail's tile), so it names the machine. */
    readonly what: string;
    /** One press, however many sides it moved: counted once, said once. */
    readonly press: number;
    readonly op: DeviceAgentOp;
    // False on a side an update only moved: it has no log or answer of its own, and is worth a strip only while it waits
    // for its own agent. The door's strip says how the run went.
    readonly door: boolean;
    readonly links: LinksAsked | undefined;
    readonly lines: readonly string[];
    /** The call is still open through this door. */
    readonly calling: boolean;
    readonly said: string | undefined;
    readonly failure: AgentFailure | undefined;
    /** What the page is waiting on once the call has ended: this side's agent coming back. */
    readonly waiting: string | undefined;
    // Past its deadline the wait stops counting as work in flight: an agent that has not come back by then is a machine
    // problem its own state badge names (offline, reconnecting), not a run to advertise on every row. The strip still says
    // it is waiting, since it still is, and a reading that shows it back still answers it.
    readonly expired: boolean;
    /** The process the press was made against: that same process answering is not the answer. */
    readonly pid: number | undefined;
    readonly installed: string | undefined;
    readonly askedAt: number;
}

// allow(module-state): device work in flight, each run stamped with the sandbox it began on and retired by its own end
const marks = shallowRef<readonly Mark[]>([]);
// allow(module-state): each environment's last agent press, kept past the page that pressed it, keyed by recordKey
const records = shallowRef<Readonly<Record<string, AgentRecord>>>({});
let last = 0;

// Long enough for a slow download and an install, short enough that a machine that never came back stops turning rows.
export const AGENT_RETURN_DEADLINE_MS = 5 * 60_000;

const recordKey = (sandboxId: string | undefined, device: string): string => `${sandboxId ?? ``}\n${device}`;
const here = (sandboxId: string | undefined): boolean => sandboxId === activeSandboxId.value;

/** The machine a device is an environment of, by the key its board card goes by; the device's own key when it stands alone. */
export const machineKeyOf = (devices: readonly Device[], device: Device): string =>
    machinesOf(devices).find((machine) => machine.environments.some((side) => side.key === device.key))?.key ?? device.key;

/** Marks work on a machine until the returned end is called. Ending twice ends it once. */
export const beginDeviceWork = (mark: DeviceWorkMark): (() => void) => {
    last += 1;
    const id = last;
    marks.value = [...marks.value, { ...mark, id, sandboxId: activeSandboxId.value }];
    return (): void => {
        marks.value = marks.value.filter((run) => run.id !== id);
    };
};

const write = (key: string, change: (record: AgentRecord) => AgentRecord | undefined): void => {
    const held = records.value[key];
    if (held === undefined) {
        return;
    }
    const next = change(held);
    records.value =
        next === undefined ? Object.fromEntries(Object.entries(records.value).filter(([heldKey]) => heldKey !== key)) : { ...records.value, [key]: next };
};

const live = (record: AgentRecord): boolean => record.calling || (record.waiting !== undefined && !record.expired);

/** One press of an agent verb, as the page that made it reports on it. */
export interface AgentPress {
    readonly line: (text: string) => void;
    /** The machine got to say how it went, which answers every side's wait. */
    readonly answered: (said: string) => void;
    /** The machine refused: nothing is on its way back. */
    readonly refused: (failure: AgentFailure) => void;
    /** The call is over however it went; whatever still waits now waits on a reading. */
    readonly ended: () => void;
}

export interface AgentAsk {
    readonly machine: string;
    /** Said away from the machine's card, so it names the machine. */
    readonly what: string;
    readonly op: DeviceAgentOp;
    /** The environment the press went through. */
    readonly door: Device;
    /** Every environment it moves, the door included: an update moves every side, the other verbs only their own. */
    readonly moved: readonly Device[];
    readonly waiting: string;
    readonly links?: LinksAsked | undefined;
}

/** Starts one press: every side it moves waits for its own agent, the door also for its call. */
export const pressAgent = (ask: AgentAsk): AgentPress => {
    last += 1;
    const press = last;
    const sandboxId = activeSandboxId.value;
    const askedAt = Date.now();
    const sides = Object.fromEntries(
        ask.moved.map((device): [string, AgentRecord] => {
            const door = device.key === ask.door.key;
            return [
                recordKey(sandboxId, device.key),
                {
                    sandboxId,
                    device: device.key,
                    machine: ask.machine,
                    what: ask.what,
                    press,
                    op: ask.op,
                    door,
                    links: door ? ask.links : undefined,
                    lines: [],
                    calling: door,
                    said: undefined,
                    failure: undefined,
                    waiting: ask.waiting,
                    expired: false,
                    pid: device.report?.agent.pid,
                    installed: device.report?.agent.installed,
                    askedAt,
                },
            ];
        }),
    );
    records.value = { ...records.value, ...sides };
    const doorKey = recordKey(sandboxId, ask.door.key);
    const mine = (key: string): boolean => records.value[key]?.press === press;
    // Every side this press still holds; a later press on one of them has taken it over.
    const each = (change: (record: AgentRecord) => AgentRecord): void => {
        for (const key of Object.keys(sides).filter(mine)) {
            write(key, change);
        }
    };
    return {
        line: (text) => {
            if (mine(doorKey)) {
                write(doorKey, (record) => ({ ...record, lines: [...record.lines, text] }));
            }
        },
        // A sentence that did arrive answers the wait too. The usual ending is none: the process carrying the reply is the
        // one being replaced, and nothing comes back but a version, later.
        answered: (said) => {
            each((record) => ({ ...record, waiting: undefined, said: record.door ? said : record.said }));
        },
        refused: (failure) => {
            each((record) => ({ ...record, waiting: undefined, failure: record.door ? failure : record.failure }));
        },
        ended: () => {
            if (mine(doorKey)) {
                write(doorKey, (record) => ({ ...record, calling: false }));
            }
            dropSpent();
        },
    };
};

// A moved side has nothing to show once its wait is over: its whole part in the run was coming back.
const dropSpent = (): void => {
    const kept = Object.entries(records.value).filter(([, record]) => record.door || record.waiting !== undefined);
    if (kept.length !== Object.keys(records.value).length) {
        records.value = Object.fromEntries(kept);
    }
};

// Whether a reading shows this side's agent back from the press: a live, unstalled loop serving the build on disk, run
// by a different process than the one the press was made against. A pid on both sides decides it; without one, an
// install that moved does, and failing that a reading the machine took after the press.
export const agentReturned = (device: Device, record: Pick<AgentRecord, `pid` | `installed` | `askedAt`>): boolean => {
    const report = device.report;
    const agent = report?.agent;
    if (device.online !== true || report === undefined || agent === undefined || !agent.running) {
        return false;
    }
    if (agentStalled(agent, report.capturedAt) || agentBuildSkew(agent) !== undefined) {
        return false;
    }
    if (record.pid !== undefined && agent.pid !== undefined) {
        return agent.pid !== record.pid;
    }
    if (record.installed !== undefined && agent.installed !== undefined && agent.installed !== record.installed) {
        return true;
    }
    return report.capturedAt > record.askedAt;
};

/** Answers every wait a reading of this sandbox's devices shows over, and retires the ones past their deadline. */
export const settleAgentRuns = (devices: readonly Device[], now: number): void => {
    const byKey = new Map(devices.map((device) => [device.key, device]));
    let changed = false;
    const next = Object.fromEntries(
        Object.entries(records.value).map(([key, record]): [string, AgentRecord] => {
            if (!here(record.sandboxId) || record.calling || record.waiting === undefined) {
                return [key, record];
            }
            const device = byKey.get(record.device);
            if (device !== undefined && agentReturned(device, record)) {
                changed = true;
                return [key, { ...record, waiting: undefined }];
            }
            if (!record.expired && now - record.askedAt > AGENT_RETURN_DEADLINE_MS) {
                changed = true;
                return [key, { ...record, expired: true }];
            }
            return [key, record];
        }),
    );
    if (changed) {
        records.value = next;
        dropSpent();
    }
};

/** Whether any press on this sandbox still waits on a reading: what keeps the watcher polling. */
export const agentReturnsPending = (): boolean =>
    Object.values(records.value).some((record) => here(record.sandboxId) && !record.calling && record.waiting !== undefined && !record.expired);

const recordOf = (device: string): AgentRecord | undefined => records.value[recordKey(activeSandboxId.value, device)];

/** The last press on this environment's agent as the strip draws it; a moved side only while it waits. */
export const agentRunOf = (device: string): AgentRun | undefined => {
    const record = recordOf(device);
    if (record === undefined || (!record.door && record.waiting === undefined)) {
        return undefined;
    }
    const state = record.calling ? `running` : record.failure !== undefined ? `failed` : record.waiting !== undefined ? `waiting` : `done`;
    return {
        op: record.op,
        state,
        lines: record.lines,
        said: record.said,
        waiting: record.waiting,
        links: record.links,
        failure: record.failure,
    };
};

/**
 * The op this environment's agent is in the middle of, from this mount or one before it: its call is open, or it has
 * not come back from it yet. Its buttons stay down for both, since a second update over one still installing is a race.
 */
export const agentInFlight = (device: string): DeviceAgentOp | undefined => {
    const record = recordOf(device);
    return record !== undefined && live(record) ? record.op : undefined;
};

/** Puts a finished run away; a call still open stays, since it is the only thing saying so. */
export const dismissAgentRun = (device: string): void => {
    const key = recordKey(activeSandboxId.value, device);
    if (records.value[key]?.calling !== true) {
        write(key, () => undefined);
    }
};

const marksHere = (): readonly Mark[] => marks.value.filter((mark) => here(mark.sandboxId));
const recordsHere = (): readonly AgentRecord[] => Object.values(records.value).filter((record) => here(record.sandboxId) && live(record));

/** One record per press: the door's while it is still live, else whichever side still waits. */
const presses = (machine?: string): readonly AgentRecord[] => {
    const seen = new Map<number, AgentRecord>();
    for (const record of recordsHere()) {
        if (machine !== undefined && record.machine !== machine) {
            continue;
        }
        const held = seen.get(record.press);
        if (held === undefined || (record.door && !held.door)) {
            seen.set(record.press, record);
        }
    }
    return [...seen.values()];
};

// The strip's own headline, so the card and the page say the same thing about the same run.
const pressDoing = (record: AgentRecord): string =>
    agentRunTitle({ op: record.op, state: record.calling ? `running` : `waiting`, lines: [], links: record.links });

// One run speaks for itself; several are counted rather than listed, as a hub row's are (hubWork.ts).
const spoken = (said: readonly string[]): string | undefined => {
    const [first] = said;
    return first === undefined ? undefined : said.length === 1 ? first : t(`sandbox.deviceWork.running`, { count: said.length });
};

/** What is moving on one machine, for its card's own line. */
export const machineWork = (machine: string): string | undefined =>
    spoken([...marksHere().filter((mark) => mark.machine === machine).map((mark) => mark.doing), ...presses(machine).map(pressDoing)]);

/** Whether this environment's own agent is in a run: the board turns its row. */
export const environmentWorking = (device: string): boolean => {
    const record = recordOf(device);
    return record !== undefined && live(record);
};

/** The sandboxes something is being done to on one machine right now. */
export const sandboxesWorking = (machine: string): readonly string[] => [
    ...new Set(marksHere().flatMap((mark) => (mark.machine === machine ? (mark.sandboxes ?? []) : []))),
];

/** Whether a call is open on this machine, from this page or one mounted before it: every button reads it as `disabled`. */
export const machineCalling = (machine: string): boolean =>
    marksHere().some((mark) => mark.machine === machine) || recordsHere().some((record) => record.machine === machine && record.calling);

/** Everything in flight on this sandbox's machines, for the Devices row and tile: the run's words, or a count. */
export const devicesWorking = (): string | undefined =>
    spoken([...marksHere().map((mark) => mark.what), ...presses().map((record) => record.what)]);

/** Test seam: the ledger is module state, and a leaked run would follow one test into the next. */
export const forgetDeviceWork = (): void => {
    marks.value = [];
    records.value = {};
};
