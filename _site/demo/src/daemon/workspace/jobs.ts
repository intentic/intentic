import type { TerminalsList } from "@intentic/sandbox-contract/schemas/terminal";
import { registerTerminalSource } from "../machine/terminals";
import { pushRuntime } from "./workspaceBroadcast";

type TerminalSession = TerminalsList[`sessions`][number];

// The terminals the workspace's verbs start, as the daemon's process supervisor starts them in tmux: an app's dev
// server (`panel-<repo>--<app>`), a one-shot add-apps or test run (`panel-<repo>--<session>`), an install. Each holds
// the lines it prints, paced like the tool printing them, so a terminal attached to it plays what a person would see,
// and the session list says it is alive until a one-shot one has printed its last line.

export interface JobLine {
    // How long after the line before it, in milliseconds.
    readonly after: number;
    readonly text: string;
}

interface Job {
    readonly name: string;
    readonly label: string;
    readonly kind: TerminalSession[`kind`];
    readonly lines: readonly JobLine[];
    readonly startedAt: number;
    readonly oneShot: boolean;
    running: boolean;
    exitCode?: number;
    timer?: ReturnType<typeof setTimeout>;
}

const JOBS = new Map<string, Job>();

const lasting = (lines: readonly JobLine[]): number => lines.reduce((sum, line) => sum + line.after, 0);

/** Starts (or restarts) the session `name`; a one-shot one ends itself after its last line, then runs `done`. */
export const startJob = (
    name: string,
    job: { label: string; kind: TerminalSession[`kind`]; lines: readonly JobLine[]; oneShot: boolean; exitCode?: number; done?: () => void },
): void => {
    clearTimeout(JOBS.get(name)?.timer);
    const started: Job = { name, label: job.label, kind: job.kind, lines: job.lines, startedAt: Date.now(), oneShot: job.oneShot, running: true };
    JOBS.set(name, started);
    if (job.oneShot) {
        started.timer = setTimeout(() => {
            started.running = false;
            started.exitCode = job.exitCode ?? 0;
            job.done?.();
            pushRuntime(`terminals`, `panels`);
        }, lasting(job.lines));
    }
    pushRuntime(`terminals`);
};

/** Ends a running session, the way stopping a dev server sends it Ctrl-C and its shell exits. */
export const stopJob = (name: string): void => {
    const job = JOBS.get(name);
    if (job === undefined) {
        return;
    }
    clearTimeout(job.timer);
    JOBS.delete(name);
    pushRuntime(`terminals`);
};

/** A terminal closed from the panel: true when it was one of these, which then ends like a stopped one. */
const endJob = (name: string): boolean => {
    const known = JOBS.has(name);
    stopJob(name);
    return known;
};

export const jobRunning = (name: string): boolean => JOBS.get(name)?.running === true;

/** How long the session `name` has been up, in milliseconds; undefined when it is not. */
export const jobAge = (name: string): number | undefined => {
    const job = JOBS.get(name);
    return job?.running === true ? Date.now() - job.startedAt : undefined;
};

/** The workspace's sessions, for `system.terminals` to list beside the rest. */
const jobSessions = (): TerminalSession[] =>
    [...JOBS.values()].map((job) => {
        const session: TerminalSession = {
            name: job.name,
            label: job.label,
            kind: job.kind,
            running: job.running,
            activityAt: job.startedAt + Math.min(Date.now() - job.startedAt, lasting(job.lines)),
        };
        if (job.exitCode !== undefined) {
            session.exitCode = job.exitCode;
        }
        return session;
    });

/** What a terminal attaching to `name` now plays: what it printed already at once, then the rest at its own pace.
 * Undefined for a session this store did not start. */
export const jobScript = (name: string): JobLine[] | undefined => {
    const job = JOBS.get(name);
    if (job === undefined) {
        return undefined;
    }
    const elapsed = Date.now() - job.startedAt;
    let at = 0;
    let shown = 0;
    return job.lines.map((line) => {
        at += line.after;
        const delay = Math.max(0, at - elapsed);
        const after = delay - shown;
        shown = delay;
        return { after, text: line.text };
    });
};

// The workspace's own sessions (an install, a test run, an app's dev server) beside the sandbox's other terminals.
registerTerminalSource(jobSessions, endJob);
