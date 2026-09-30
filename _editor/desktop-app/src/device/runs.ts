import { computed, ref } from "vue";
import { parseStep, type RunEvent } from "../desktop";
import { refresh } from "./machine";

// THE APP'S SCRIPT RUNS ON THIS MACHINE (scripts.rs): a setup, a sync enrollment, a sandbox started, recreated or removed.
// Each is one run, reported by its own id (`setup`, `power:<slug>`, `recreate:<slug>`, …) on `desktop://run`, and every
// line it prints is kept under that id for the page to show. One runs at a time: they all drive docker on one machine.

export const runs = ref<Record<string, RunEvent[]>>({});
export const activeRun = ref<string | undefined>(undefined);
export const running = computed(() => activeRun.value !== undefined);

export const eventsOf = (run: string): RunEvent[] => runs.value[run] ?? [];

/** One event of a run, kept under its id. */
export const record = (event: RunEvent): void => {
    runs.value = { ...runs.value, [event.run]: [...eventsOf(event.run), event] };
};

/** The lines a run printed, as the page's log panes show them. */
export const linesOf = (run: string): string[] => eventsOf(run).flatMap((event) => (event.kind === `line` ? [event.text] : []));

/**
 * Run `action` as the run `id`, reported the same way as every other: its events start afresh, it is the active run
 * until it ends, and the machine is read again after. What failed comes back as its message, nothing when it worked.
 */
export const start = async (id: string, action: () => Promise<void>): Promise<string | undefined> => {
    runs.value = { ...runs.value, [id]: [] };
    activeRun.value = id;
    try {
        await action();
        return undefined;
    } catch (error) {
        return String(error);
    } finally {
        activeRun.value = undefined;
        await refresh();
    }
};

/** How a run went, as the app's analytics report it: never a name, a path or a line of output. */
export interface RunOutcome {
    readonly ok: boolean;
    readonly durationMs: number;
    readonly exitCode: number | null;
    readonly steps: number;
    /** Only on failure: a successful run's last step is just the last step. */
    readonly failedStep?: string;
}

// Last phase id before a failure, not the sentence, so wording changes don't break funnel comparisons.
const stepOf = (event: RunEvent): string | undefined => (event.kind === `line` && event.stream === `stdout` ? parseStep(event.text)?.phase : undefined);

export const runOutcome = (id: string, ok: boolean, startedAt: number): RunOutcome => {
    const events = eventsOf(id);
    const exit = events.findLast((event) => event.kind === `exit`);
    const phases = events.map(stepOf).filter((phase): phase is string => phase !== undefined);
    const outcome: RunOutcome = { ok, durationMs: Date.now() - startedAt, exitCode: exit?.kind === `exit` ? exit.code : null, steps: phases.length };
    const failedStep = phases.at(-1);
    return ok || failedStep === undefined ? outcome : { ...outcome, failedStep };
};
