import type { ListenerDispatchFrame, ListenerPlanItem, ListenerStep, ListenerTurnOpened } from "@intentic/sandbox-contract";

// What a chat shows of a turn while it works, folded from the daemon's dispatch frames: the turn it opened, the agent's
// steps in the order they began, its checklist, and whether it is writing its reply right now. Pure state and wording,
// shared by every gateway; how it is drawn (an embed, a block, a line) stays in each gateway.

// How many steps a status keeps; older ones are only counted. A status line shows a handful, never the whole log.
export const STEPS_KEPT = 40;

export interface TurnProgress {
    readonly opened?: ListenerTurnOpened;
    // When the first frame arrived; a wake held or queued first waits from here.
    readonly startedAt: number;
    // When the turn opened, the clock a working status's elapsed time reads from.
    readonly openedAt?: number;
    // Distinct steps in the order they began, the newest last, at most STEPS_KEPT of them.
    readonly steps: readonly ListenerStep[];
    // Every distinct step seen, kept or not.
    readonly stepCount: number;
    readonly plan?: readonly ListenerPlanItem[];
    // Reply text has arrived since the last step began: the agent is writing.
    readonly writing: boolean;
    readonly held?: string;
    readonly queued?: string;
    readonly failed?: string;
    readonly ended: boolean;
}

export interface TurnProgressTracker {
    // Folds one frame in; answers whether anything a status shows changed.
    readonly apply: (frame: ListenerDispatchFrame) => boolean;
    readonly state: () => TurnProgress;
}

export const trackTurnProgress = (now: () => number = Date.now): TurnProgressTracker => {
    let state: TurnProgress = { startedAt: now(), steps: [], stepCount: 0, writing: false, ended: false };
    const step = (next: ListenerStep): boolean => {
        const at = state.steps.findIndex((known) => known.id === next.id);
        if (at === -1) {
            const steps = [...state.steps, next].slice(-STEPS_KEPT);
            state = { ...state, steps, stepCount: state.stepCount + 1, writing: false };
            return true;
        }
        const known = state.steps[at];
        // A settled step's later frame (a subagent's description arriving after its call) keeps the settled status.
        const status = known !== undefined && known.status !== "running" && next.status === "running" ? known.status : next.status;
        const merged: ListenerStep = { ...known, ...next, status };
        state = { ...state, steps: state.steps.map((each, index) => (index === at ? merged : each)) };
        return true;
    };
    return {
        apply: (frame) => {
            let changed = false;
            if (frame.opened !== undefined) {
                state = { ...state, opened: frame.opened, openedAt: now() };
                changed = true;
            }
            if (frame.step !== undefined) {
                changed = step(frame.step) || changed;
            }
            if (frame.plan !== undefined) {
                state = { ...state, plan: frame.plan };
                changed = true;
            }
            if (frame.delta !== undefined && frame.delta !== "" && !state.writing) {
                state = { ...state, writing: true };
                changed = true;
            }
            if (frame.held !== undefined) {
                state = { ...state, held: frame.held };
                changed = true;
            }
            if (frame.queued !== undefined) {
                state = { ...state, queued: frame.queued };
                changed = true;
            }
            if (frame.failed !== undefined) {
                state = { ...state, failed: frame.failed };
                changed = true;
            }
            if (frame.end === true) {
                state = { ...state, ended: true, writing: false };
                changed = true;
            }
            return changed;
        },
        state: () => state,
    };
};

// What a step says in a status line: a verb in the tense its status calls for, and what it acted on.
export interface StepPhrase {
    readonly verb: string;
    readonly object?: string;
}

// Each kind of step's verb while it runs and once it settled.
const VERBS = {
    read: ["Reading", "Read"],
    edit: ["Editing", "Edited"],
    delete: ["Deleting", "Deleted"],
    move: ["Moving", "Moved"],
    search: ["Searching", "Searched"],
    execute: ["Running", "Ran"],
    think: ["Thinking", "Thought"],
    fetch: ["Fetching", "Fetched"],
    delegate: ["Delegating", "Delegated"],
    other: ["Using", "Used"],
} as const satisfies Record<ListenerStep["kind"], readonly [running: string, settled: string]>;

// How long a step's object may run before it is shortened; a status line is a glance, not a log.
export const OBJECT_MAX = 72;

const ellipsize = (text: string, max: number): string => (text.length <= max ? text : `${text.slice(0, max - 1).trimEnd()}…`);

// A long path keeps its last segments, which say what the file is; the front is the same for every file in a repo.
const shortPath = (path: string, max: number): string => {
    if (path.length <= max) {
        return path;
    }
    const segments = path.split("/");
    for (let keep = segments.length - 1; keep >= 1; keep -= 1) {
        const tail = `…/${segments.slice(-keep).join("/")}`;
        if (tail.length <= max) {
            return tail;
        }
    }
    return ellipsize(path, max);
};

// A command's first line, without the `cd <somewhere> &&` an agent puts before half its commands.
const shortCommand = (command: string, max: number): string =>
    ellipsize(
        (command.split("\n")[0] ?? "")
            .replace(/^\s*cd\s+\S+\s*&&\s*/, "")
            .trim(),
        max,
    );

// A URL as its host and path, which is what says where the agent went.
const shortUrl = (url: string, max: number): string => {
    try {
        const parsed = new URL(url);
        return ellipsize(`${parsed.host}${parsed.pathname === "/" ? "" : parsed.pathname}`, max);
    } catch {
        // allow(silent-catch): a target that is not a URL is shown as the text it is
        return ellipsize(url, max);
    }
};

// An MCP tool's wire name (`mcp__github__create_pull_request`) as words a person reads ("github: create pull request").
export const toolWords = (tool: string): string => {
    const mcp = /^mcp__([^_]+(?:_[^_]+)*?)__(.+)$/.exec(tool);
    if (mcp !== null) {
        return `${mcp[1] ?? ""}: ${(mcp[2] ?? "").replaceAll("_", " ")}`;
    }
    return tool;
};

// The step as a status line words it. `quiet` drops what it acted on (paths, commands, queries) for a channel that should
// see that the agent works, not what it touches.
export const stepPhrase = (step: ListenerStep, quiet = false): StepPhrase => {
    const [running, settled] = VERBS[step.kind];
    const verb = step.status === "running" ? running : settled;
    const target = step.target?.trim();
    if (step.kind === "other") {
        return { verb, object: toolWords(step.tool) };
    }
    if (quiet || target === undefined || target === "") {
        return { verb };
    }
    switch (step.kind) {
        case "read":
        case "edit":
        case "delete":
        case "move":
            return { verb, object: shortPath(target, OBJECT_MAX) };
        case "execute":
            return { verb, object: shortCommand(target, OBJECT_MAX) };
        case "fetch":
            return { verb, object: shortUrl(target, OBJECT_MAX) };
        default:
            return { verb, object: ellipsize(target.replaceAll(/\s+/g, " "), OBJECT_MAX) };
    }
};

// The step a status leads with: the newest one still running.
export const currentStep = (progress: TurnProgress): ListenerStep | undefined => progress.steps.findLast((step) => step.status === "running");

// How long the turn has worked: since it opened, or since the first frame for one that never did.
export const elapsedOf = (progress: TurnProgress, now: number): number => now - (progress.openedAt ?? progress.startedAt);

// A duration as a status reads it: "42s", "3m 05s", "1h 02m".
export const formatElapsed = (ms: number): string => {
    const seconds = Math.max(0, Math.floor(ms / 1000));
    if (seconds < 60) {
        return `${seconds}s`;
    }
    const minutes = Math.floor(seconds / 60);
    if (minutes < 60) {
        return `${minutes}m ${String(seconds % 60).padStart(2, "0")}s`;
    }
    return `${Math.floor(minutes / 60)}h ${String(minutes % 60).padStart(2, "0")}m`;
};
