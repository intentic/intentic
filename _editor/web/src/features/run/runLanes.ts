import type { PanelSummary } from "@intentic/sandbox-contract/schemas/panels";
import type { DeviceRun, RepoRunTargets, RunTargetsList, RunTerminal } from "@intentic/sandbox-contract/schemas/run-targets";
import type { PreviewTarget } from "../../models/preview/previewModel";
import { type RunRow, runRowsOf, runsAt, SANDBOX } from "./runRows";

/* THE RUN VIEW'S LANES, one per place a program can run: the sandbox first, then each of the owner's computers. Pure:
   what every repository can run (runRows.ts), the live sandbox targets, the computers and what each one says runs on it
   in, lanes out. A lane answers "what runs here, and what could I start here":
   - `active`: what is running, starting (its build or push still going in a terminal) or fell over there. On a computer
     that is whatever the machine reports, whoever started it: a program no run.json names is listed too, by its own name.
   - `idle`: what can be started there and is not running. A computer target appears on the lane of the computer its
     file names, or on every computer when it names none, so a lane is not a copy of every other lane.
   - `runnable`: every computer target in scope, whatever computer it names, for the lane's own "Run…" choice: the way to
     run one somewhere other than its default. */

export type RunDevice = RunTargetsList[`devices`][number];

// Why a computer cannot take a run now: asleep, an agent too old to run programs, or its switch off.
export type RunBlock = `offline` | `agentTooOld` | `switchOff`;

const blockOf = (device: RunDevice): RunBlock | undefined => {
    if (!device.online) {
        return `offline`;
    }
    if (!device.programs) {
        return `agentTooOld`;
    }
    return device.allowed ? undefined : `switchOff`;
};

// What one computer said runs on it (the daemon's `runs.active`); undefined while unread.
export interface DeviceRunList {
    readonly runs: readonly DeviceRun[];
    readonly terminals: readonly RunTerminal[];
    readonly error?: string | undefined;
}

// running: up (or answering, in the sandbox). starting: a sandbox server not answering yet, or a computer's build, push
// or launch still going in its terminal. unknown: its process is alive but the computer cannot say it is this run.
// failed: its newest run there ended with a failing code. idle: nothing of it runs there.
export type RunState = `running` | `starting` | `unknown` | `failed` | `idle`;

export interface RunItem {
    // Unique within its lane: the repository and the row's key, or the computer's run id for a program no row names.
    readonly key: string;
    readonly repo: string | undefined;
    // What the repository declares; undefined for a program the computer runs that no run.json in scope names.
    readonly row: RunRow | undefined;
    // On a computer: the newest run of it there, and the terminal it is still being built or followed in.
    readonly run: DeviceRun | undefined;
    readonly terminal: RunTerminal | undefined;
    readonly state: RunState;
}

export interface RunnableTarget {
    readonly repo: string;
    readonly row: RunRow;
}

export interface RunLane {
    // SANDBOX, or the computer's id.
    readonly place: string;
    readonly device: RunDevice | undefined;
    readonly block: RunBlock | undefined;
    readonly active: readonly RunItem[];
    readonly idle: readonly RunItem[];
    readonly runnable: readonly RunnableTarget[];
    // Why the computer's list could not be read, so an empty lane is not taken for "nothing runs there".
    readonly listError: string | undefined;
}

// One repository's run sources, as the view reads them.
export interface RunRepo {
    readonly repo: string;
    readonly declared: RepoRunTargets | undefined;
    readonly panel: PanelSummary | undefined;
}

export interface RunLaneInput {
    // Every repository with something to run, in or out of scope: a computer's program is matched to its target by
    // name across all of them, so a program of a repository out of scope is not mistaken for one no file names.
    readonly repos: readonly RunRepo[];
    readonly live: readonly PreviewTarget[];
    readonly devices: readonly RunDevice[];
    readonly runsOn: (device: string) => DeviceRunList | undefined;
    // Whether the view shows a repository's runs now (the open project); undefined is a program no repository is known
    // for. Narrowed to one repository after (narrowLanes), so the picker can count every repository's runs.
    readonly inScope: (repo: string | undefined) => boolean;
}

interface Declared {
    readonly repo: string;
    readonly row: RunRow;
}

// What needs the reader first: a failure, then what is still on its way, then what is up.
const ORDER = { failed: 0, starting: 1, unknown: 2, running: 3, idle: 4 } as const satisfies Record<RunState, number>;
const byState = (left: RunItem, right: RunItem): number => ORDER[left.state] - ORDER[right.state];

const sandboxState = (row: RunRow): RunState => {
    const target = row.sandbox;
    if (target?.running !== true) {
        return `idle`;
    }
    return target.healthy ? `running` : `starting`;
};

const computerState = (run: DeviceRun | undefined, terminal: RunTerminal | undefined): RunState => {
    if (run?.state === `running`) {
        return `running`;
    }
    if (terminal !== undefined) {
        return `starting`;
    }
    if (run?.state === `unknown`) {
        return `unknown`;
    }
    return run?.exitCode !== undefined && run.exitCode !== 0 ? `failed` : `idle`;
};

const sandboxLane = (rows: readonly Declared[]): RunLane => {
    const items = rows
        .filter(({ row }) => runsAt(row, SANDBOX))
        .map(({ repo, row }): RunItem => ({ key: `${repo}/${row.key}`, repo, row, run: undefined, terminal: undefined, state: sandboxState(row) }));
    return {
        place: SANDBOX,
        device: undefined,
        block: undefined,
        active: items.filter((item) => item.state !== `idle`).toSorted(byState),
        idle: items.filter((item) => item.state === `idle`),
        runnable: [],
        listError: undefined,
    };
};

const READINESS = { ready: 0, agentTooOld: 1, switchOff: 1, offline: 2 } as const satisfies Record<RunBlock | `ready`, number>;

// Whether an idle target is listed on this computer's lane: the computer its file names, or every one when it names
// none or names one this sandbox does not know.
const placedOn = (row: RunRow, device: string, known: ReadonlySet<string>): boolean =>
    row.device === undefined || row.device === device || !known.has(row.device);

const computerLane = (device: RunDevice, scoped: readonly Declared[], every: readonly Declared[], input: RunLaneInput): RunLane => {
    const block = blockOf(device);
    const list = input.runsOn(device.id);
    const runs = list?.runs ?? [];
    const known = new Set(input.devices.map((candidate) => candidate.id));
    const targets = scoped.filter(({ row }) => row.computers);
    const claimed = new Set<string>();
    const items = targets.map(({ repo, row }): RunItem => {
        // The machine lists newest first; a run started before this sandbox last came up names no repository.
        const run = runs.find((candidate) => candidate.name === row.name && (candidate.repo === undefined || candidate.repo === repo));
        if (run !== undefined) {
            claimed.add(run.id);
        }
        const terminal = list?.terminals.find((open) => open.repo === repo && open.target === row.name);
        return { key: `${repo}/${row.key}`, repo, row, run, terminal, state: computerState(run, terminal) };
    });
    // Programs running there that no target in scope claimed: an agent's app_start, a terminal's `devices start`, or a
    // target of a repository whose file has since changed. Kept to the scope by the repository they were started from.
    const strangers = runs
        .filter((run) => run.state !== `ended` && !claimed.has(run.id))
        .map((run): RunItem => {
            const repo = run.repo ?? every.find(({ row }) => row.computers && row.name === run.name)?.repo;
            return { key: `run:${run.id}`, repo, row: undefined, run, terminal: undefined, state: computerState(run, undefined) };
        })
        .filter((item) => input.inScope(item.repo));
    return {
        place: device.id,
        device,
        block,
        active: [...items.filter((item) => item.state !== `idle`), ...strangers].toSorted(byState),
        // On a computer that cannot take a run, only what names it waits for it: the rest can run elsewhere.
        idle: items.filter(
            (item) => item.state === `idle` && item.row !== undefined && (block === undefined ? placedOn(item.row, device.id, known) : item.row.device === device.id),
        ),
        runnable: targets,
        listError: list?.error,
    };
};

export const runLanesOf = (input: RunLaneInput): RunLane[] => {
    const every = input.repos.flatMap(({ repo, declared, panel }) => runRowsOf(repo, declared, panel, input.live).map((row): Declared => ({ repo, row })));
    const scoped = every.filter(({ repo }) => input.inScope(repo));
    const sandbox = sandboxLane(scoped);
    const computers = input.devices
        .map((device) => computerLane(device, scoped, every, input))
        // A computer is a lane while something in scope can run on one, or while it runs something of the scope's. One that
        // cannot take a run is a lane only while a target waits for it by name: its card, not this view, is where it is
        // set up.
        .filter((lane) => lane.active.length > 0 || (lane.block === undefined ? lane.runnable.length > 0 : lane.idle.length > 0))
        // Those that can take a run first, then those refusing until a switch is turned, then those asleep; by name within.
        .toSorted((left, right) => READINESS[left.block ?? `ready`] - READINESS[right.block ?? `ready`] || left.place.localeCompare(right.place));
    return [...(sandbox.active.length + sandbox.idle.length > 0 ? [sandbox] : []), ...computers];
};

const up = (item: RunItem): boolean => item.state === `running` || item.state === `unknown`;

// How many programs run across the lanes, of one repository when it is named: what the view's title row and the
// repository picker count.
export const runningCount = (lanes: readonly RunLane[], repo?: string): number =>
    lanes.reduce((sum, lane) => sum + lane.active.filter((item) => up(item) && (repo === undefined || item.repo === repo)).length, 0);

// How many programs run on the lane.
export const laneRunning = (lane: RunLane): number => lane.active.filter(up).length;

// The lanes as one repository sees them: its rows only, and only the places it runs in or runs something on.
export const narrowLanes = (lanes: readonly RunLane[], repo: string | undefined): RunLane[] => {
    if (repo === undefined) {
        return [...lanes];
    }
    return lanes
        .map(
            (lane): RunLane => ({
                ...lane,
                active: lane.active.filter((item) => item.repo === repo),
                idle: lane.idle.filter((item) => item.repo === repo),
                runnable: lane.runnable.filter((target) => target.repo === repo),
            }),
        )
        .filter((lane) => lane.active.length > 0 || (lane.place === SANDBOX ? lane.idle.length > 0 : lane.runnable.length > 0));
};
