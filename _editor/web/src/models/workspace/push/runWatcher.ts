import type { CommandRun } from "@intentic/sandbox-contract/schemas/ci";
import { followCommandRun } from "@intentic/sandbox-contract/policy/command-run";
import { messageOr } from "@intentic/ui/async";
import { computed, type ComputedRef, ref } from "vue";
import { importOrReload } from "../../../lib/staleChunk";
import { holdQuietRun, type QuietRunRow } from "../../terminal/quietRuns";
import type { useTerminalPanel } from "../../terminal/useTerminalPanel";

// Starts, watches and stops a daemon command, revealing its tmux terminal once: when the session first appears, or for
// a quiet source only when there is something to read (it failed, or it is taking long).
// Polls only its verdict while running; poll errors are reported and retried so the surface can still settle.
// A per-watcher interval keeps re-renders from restarting the run and leaves the terminal's visibility to the user.

// The wait between polls, short enough that the answer follows the terminal's last line, and cheap: memory-only.
const POLL_MS = 700;

// What a source says about its run: where it starts, is read, stops, and its words for the terminal panel and
// error line. Everything else (cadence, reveal, settle) is the watcher's, shared by every source.
export interface RunSource<R extends CommandRun> {
    // The shape at rest: what the watcher shows before the first poll and after `forget`.
    readonly idle: R;
    readonly start: () => Promise<unknown>;
    readonly state: () => Promise<R>;
    readonly cancel: () => Promise<unknown>;
    // What the terminal panel is told it's opening on, since the panel can't know; undefined means no panel to open.
    readonly reveal: (run: R) => { readonly title: string; readonly detail: string } | undefined;
    // The error lines' fallbacks, when the failure carries no words of its own: "Could not start the push.", "Lost
    // contact with the push." Whole sentences, built when said, so each language puts the noun in its own case.
    readonly says: { readonly startFailed: () => string; readonly lostContact: () => string; readonly stopFailed: () => string };
    // A run made so often that opening the panel for each one is noise (a push). It goes off screen, said only by the
    // rail's terminal tile (`row`, quietRuns.ts), and its terminal opens by itself only when it fails or is still going
    // after `slowMs`. A panel the slow reveal opened closes again once the run passes. Absent, the terminal opens as soon
    // as the run names it.
    readonly quiet?: { readonly slowMs: number; readonly row: () => QuietRunRow };
}

export interface RunWatcher<R extends CommandRun> {
    readonly run: ComputedRef<R>;
    readonly error: ComputedRef<string | undefined>;
    readonly running: ComputedRef<boolean>;
    // Whether there's a terminal to send the user to; what a "Show terminal" button is drawn on.
    readonly terminal: ComputedRef<string | undefined>;
    // Starts a run and follows it to a terminal state, resolving with the settled run so a call site reads as one
    // sentence. The daemon arbitrates "one at a time", so calling it again just joins a run already going.
    readonly start: () => Promise<R>;
    // Stops the run; the daemon settles it as `cancelled`, so the wording matches any other outcome's.
    readonly cancel: () => Promise<void>;
    // Drops the run from view without touching the daemon (what closing the surface does); a run still going
    // keeps going in its terminal, unwatched. The terminal tab stays open as the record of what ran.
    readonly forget: () => void;
    // The button beside a running command: the poll may reveal once by itself, this is the user asking.
    readonly showTerminal: () => void;
}

// A settled run worth reading: refused, or not runnable at all. A cancel was the reader's own hand, a pass says nothing.
const troubled = (run: CommandRun): boolean => run.status === `failed` || run.status === `error`;

type TerminalPanel = ReturnType<typeof useTerminalPanel>;

// Reached lazily, not for style: the panel module touches `window`/`document` at load, while this watcher is imported by
// stores that run without a DOM. A microtask-later reveal is still the same user-visible moment, and the callbacks land
// in the order they were asked for.
const withPanel = (use: (panel: TerminalPanel) => void): void => {
    importOrReload(
        () => import(`../../terminal/useTerminalPanel`),
        ({ useTerminalPanel }) => use(useTerminalPanel()),
    );
};

// When a run's terminal opens by itself: once per run, at once, or for a quiet source only when it failed or is taking
// long. A quiet run is held on the terminal tile for exactly as long as it runs.
interface Reveals<R> {
    // A run starting, or dropped from view: nothing shown yet, nothing held.
    readonly reset: () => void;
    // One state read; `began` is when the run started.
    readonly read: (state: R, began: number) => void;
    // The reader asking: opens it whatever the policy, and counts as this run's one reveal.
    readonly show: (state: R) => void;
}

const createReveals = <R extends CommandRun>(source: RunSource<R>): Reveals<R> => {
    const { quiet } = source;
    let shown = false;
    let unhold: (() => void) | undefined;
    // Revealed for taking long, and whether that found the panel closed: a pass then hands back the screen they had.
    let slow = false;
    let openedClosedPanel = false;

    const reveal = (state: R, onOpen?: (panel: TerminalPanel) => void): void => {
        const { session } = state;
        const words = session === undefined ? undefined : source.reveal(state);
        if (session !== undefined && words !== undefined) {
            shown = true;
            withPanel((panel) => {
                onOpen?.(panel);
                panel.openFocused(session, words);
            });
        }
    };

    const release = (): void => {
        unhold?.();
        unhold = undefined;
    };

    const settle = (state: R): void => {
        release();
        if (slow) {
            slow = false;
            withPanel((panel) => {
                if (openedClosedPanel && state.status === `passed`) {
                    panel.setOpen(false);
                }
                openedClosedPanel = false;
            });
        }
    };

    const read = (state: R, began: number): void => {
        const going = state.status === `running`;
        if (quiet !== undefined && going && state.session !== undefined) {
            unhold ??= holdQuietRun(quiet.row);
        }
        if (!shown && (quiet === undefined || troubled(state))) {
            reveal(state);
        } else if (!shown && going && quiet !== undefined && Date.now() - began >= quiet.slowMs) {
            slow = true;
            reveal(state, (panel) => {
                openedClosedPanel = !panel.open.value;
            });
        }
        if (!going) {
            settle(state);
        }
    };

    const reset = (): void => {
        release();
        shown = false;
        slow = false;
        openedClosedPanel = false;
    };

    return { reset, read, show: (state) => reveal(state) };
};

export const createRunWatcher = <R extends CommandRun>(source: RunSource<R>): RunWatcher<R> => {
    const run = ref(source.idle) as { value: R };
    const error = ref<string | undefined>(undefined);
    const reveals = createReveals(source);
    // The follow in progress, aborted by `forget` and the next `start`; one at a time per watcher.
    let following: AbortController | undefined;

    const stopFollowing = (): void => {
        following?.abort();
        following = undefined;
    };

    const start = async (): Promise<R> => {
        stopFollowing();
        reveals.reset();
        error.value = undefined;
        run.value = { ...source.idle, status: `running` };
        try {
            await source.start();
        } catch (cause) {
            error.value = messageOr(cause, source.says.startFailed());
            run.value = source.idle;
            return run.value;
        }
        const follow = new AbortController();
        following = follow;
        const began = Date.now();
        // The poll loop is the contract's (followCommandRun); this watcher owns only what each state means to a screen.
        const settled = await followCommandRun(source.state, {
            intervalMs: POLL_MS,
            signal: follow.signal,
            onState: (state) => {
                run.value = state;
                error.value = undefined;
                reveals.read(state, began);
            },
            onError: (cause) => {
                error.value = messageOr(cause, source.says.lostContact());
            },
        });
        if (following === follow) {
            following = undefined;
        }
        // Forgotten mid-run: the daemon keeps going, but the surface shows the rest state `forget` already put there.
        return settled ?? run.value;
    };

    const cancel = async (): Promise<void> => {
        try {
            await source.cancel();
        } catch (cause) {
            error.value = messageOr(cause, source.says.stopFailed());
        }
    };

    const forget = (): void => {
        stopFollowing();
        reveals.reset();
        run.value = source.idle;
        error.value = undefined;
    };

    return {
        run: computed(() => run.value),
        error: computed(() => error.value),
        running: computed(() => run.value.status === `running`),
        terminal: computed(() => run.value.session),
        start,
        cancel,
        forget,
        showTerminal: () => reveals.show(run.value),
    };
};
