import { timeAgo } from "@intentic/ui/format";
import type { TerminalTab } from "./useTerminal";

/* WHICH TERMINALS THE STRIP CALLS INACTIVE: one rule, in one place, because three surfaces ask it and they must
 * agree. The bar menu's row states a COUNT ("Kill 3 inactive terminals"), the palette command fires the same
 * sweep from a keyboard, and the confirm names the terminals the count stood for. A row that promised three and
 * a dialog that listed four would be the worst possible version of this feature: the whole reason a sweep is
 * confirmable is that its gesture never names what it takes.
 *
 * INACTIVE IS TWO FACTS, AND NEITHER OF THEM IS `running`. A `web-*` shell reports `running: true` at a bare
 * prompt exactly as it does mid-build (see the contract's note on `command`), so a sweep keyed on liveness would
 * take the entire strip. What it asks instead:
 *
 *   · NOTHING IS HAPPENING IN IT. `command` is the daemon's read of the live pane (`pane_current_command`),
 *     absent while it waits at a prompt. Anything with a command in it is spared however long it has been
 *     silent: a compile that prints nothing for twenty minutes is the single most expensive thing this sweep
 *     could take, and "quiet" is exactly what that looks like from here.
 *   · AND IT HAS BEEN QUIET A WHILE. `activityAt` is when it last produced output. Without the clock the sweep
 *     would also take the shell you ran `ls` in ten seconds ago, which is a shell you are using.
 *
 * A FINISHED PANE (`running: false`, a dead one-shot job, a dev server that stopped) needs neither test: its
 * last window has exited, so there is nothing to be quiet about and no clock to consult. It sweeps on the
 * strength of being over.
 *
 * WHAT IS NEVER SWEPT, each a rule rather than an oversight:
 *   · a background process's log view (`process`). Its × closes a VIEW, never the process, whose lifecycle
 *     belongs to the popover's Stop, so sweeping one would be a no-op that lied about the count.
 *   · the terminal you are LOOKING AT, prompt or not. A sweep that emptied the panel out from under its reader
 *     would be "Kill all terminals" wearing a narrower label, and that row is directly below this one.
 *   · a live session tmux gave no stamp for. `activityAt` 0 means "it did not say" (never 1970), so its age is
 *     unknown, and a sweep may not kill what it cannot age. */

// How long a terminal sits at its prompt before the strip counts it as inactive. Ten minutes: long enough that
// the shell you stepped away from mid-task is still there when you come back with coffee, short enough that the
// six you opened this morning are gone by the afternoon. Stated out loud in the confirm, because a rule the
// user cannot see is a rule they cannot trust.
export const QUIET_MS = 10 * 60_000;

export interface SweepContext {
    // The clock to age `activityAt` against, passed in rather than read here: the panel stamps it at the
    // gesture, and a test needs to place a session in the past without waiting ten minutes for one.
    readonly now: number;
    // The focused session, spared whatever its state. Undefined when the strip has no active tab.
    readonly focused?: string | undefined;
    readonly quietMs?: number;
}

export const inactiveTerminals = (tabs: readonly TerminalTab[], { now, focused, quietMs = QUIET_MS }: SweepContext): TerminalTab[] =>
    tabs.filter(
        (tab) =>
            tab.kind !== `process` &&
            tab.name !== focused &&
            tab.command === undefined &&
            (!tab.running || (tab.activityAt > 0 && now - tab.activityAt >= quietMs)),
    );

// Why this one qualified, for the row the confirm draws it as. The dialog is where a count becomes checkable,
// and "3 inactive terminals" is only checkable if each line says what made it inactive.
export const inactiveReason = (tab: TerminalTab, now: number): string =>
    tab.running ? `last output ${timeAgo(tab.activityAt, { now, days: true })}` : `finished`;
