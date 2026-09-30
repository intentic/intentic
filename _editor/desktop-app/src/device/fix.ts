import { computed, ref, watch } from "vue";
import { track } from "../analytics";
import { sandboxFix, takePendingFix, type FixArgs, type RunEvent } from "../desktop";
import { endFix, type FixEnd, foldFixLine, startFix, type FixView, verdictOf } from "../fixReport";
import { info, sandboxes } from "./machine";
import { activeRun, running, start } from "./runs";

// THE RECOVERY PANEL'S "FIX IT" (intentic://fix, src-tauri/src/fix.rs): `ic sandbox fix` for a sandbox on this machine,
// drawn from ic's own lines (fixReport.ts) at the top of This device, which the app brings forward for it. One at a
// time, under its own run id, and serialized with every other run here like they are with each other (runs.ts): they
// all drive docker on one machine. ic reports the run to the platform itself, which is how the panel that asked follows it.

const FIX_RUN = `fix`;

/** A fix on This device: what the link asked, what ic has said so far, and what stopped it before it ran. */
export interface SandboxFix {
    readonly args: FixArgs;
    readonly view: FixView;
    /** False while another run on this device finishes: the fix starts the moment that one ends (the watch below). */
    readonly started: boolean;
    readonly failure?: string;
}

export const fix = ref<SandboxFix | undefined>(undefined);
export const fixQueued = computed(() => fix.value !== undefined && !fix.value.started);
/** ic's run is going: what the rail's tile spins for while the reader is elsewhere (badge.ts). */
export const fixRunning = computed(() => activeRun.value === FIX_RUN);
// Read off the app (fix.rs `LIMIT`) rather than said twice; `info` is read before any link is taken (useDevice.ts).
export const fixLimitMinutes = computed(() => Math.round((info.value?.fixLimitSeconds ?? 0) / 60));
// The name this app remembers for the sandbox, else its slug.
export const fixName = computed(() => {
    const slug = fix.value?.args.slug ?? ``;
    return sandboxes.value.find((sandbox) => sandbox.slug === slug)?.name ?? slug;
});

const held = (args: FixArgs, view: FixView, failure: string | undefined): SandboxFix =>
    failure === undefined ? { args, view, started: true } : { args, view, started: true, failure };

// `accept` names the checks the user just said yes to. That re-run carries no code: the run the link came with claimed
// it, and ic reports to that panel's sandbox without one from then on.
export const runFix = async (accept: readonly string[] = []): Promise<void> => {
    const asked = fix.value;
    if (asked === undefined || running.value) {
        return;
    }
    const code = accept.length === 0 ? asked.args.code : undefined;
    const startedAt = Date.now();
    fix.value = { args: asked.args, view: startFix(asked.args.slug), started: true };
    track(`desktop_fix_started`, { consent: accept.length > 0, code: (code ?? ``) !== `` });
    // Asked here and awaited through `start`, which owns the run's bookkeeping; its events cannot arrive before `start`
    // has cleared the run's lines, since the answer is at least one IPC round trip away.
    const answered = sandboxFix(asked.args.slug, code, accept);
    const failure = await start(FIX_RUN, () => answered.then(() => undefined));
    const end: FixEnd | undefined = failure === undefined ? await answered : undefined;
    const current = fix.value;
    if (current === undefined) {
        return;
    }
    const view = end === undefined ? current.view : endFix(current.view, end);
    fix.value = held(current.args, view, failure);
    // The verdict's kind, ic's own outcome word and exit code: never a check's words, a slug or a line of output.
    track(`desktop_fix_finished`, {
        verdict: failure === undefined ? verdictOf(view).kind : `didNotStart`,
        outcome: view.outcome ?? null,
        exitCode: end?.code ?? null,
        checks: view.checks.map((check) => `${check.id}:${check.state}`),
        consent: accept.length > 0,
        durationMs: Date.now() - startedAt,
    });
};

/** One event of a run: the fix's lines build its view as they arrive (fixReport.ts); every other run's pass by. */
export const foldFix = (event: RunEvent): void => {
    const current = fix.value;
    if (event.run === FIX_RUN && event.kind === `line` && current !== undefined) {
        fix.value = { ...current, view: foldFixLine(current.view, event.stream, event.text) };
    }
};

watch(running, (going) => {
    if (!going && fixQueued.value) {
        void runFix();
    }
});

/**
 * The request the app parked for the main window, taken, not read. While one is held or running, a second link only
 * brought the window forward (fix.rs), and the one on screen stays the one on screen.
 */
export const drainFix = async (): Promise<void> => {
    const requested = await takePendingFix();
    const current = fix.value;
    if (requested === null || (current !== undefined && current.failure === undefined && current.view.end === undefined)) {
        return;
    }
    fix.value = { args: requested, view: startFix(requested.slug), started: false };
    await runFix();
};

export const dismissFix = (): void => {
    fix.value = undefined;
};
