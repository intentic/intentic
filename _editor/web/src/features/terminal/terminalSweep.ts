import { timeAgo } from "@intentic/ui/format";
import type { TerminalTab } from "./useTerminal";

// Single definition of 'inactive', used by the bar-menu count, palette command, and confirm list so they agree. Quiet:
// no live command and idle past quietMs, or already finished. activityAt 0 means unmeasured, not epoch, so an unstamped
// live session is spared, and a process's log view or the focused terminal are never swept.

// How long a terminal must sit quiet before the sweep counts it inactive.
export const QUIET_MS = 10 * 60_000;

export interface SweepContext {
    // Clock to age `activityAt` against; injected so tests can place a session in the past without waiting.
    readonly now: number;
    // Focused session, always spared regardless of its state.
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

// Per-terminal reason shown in the sweep confirm, so a count can be checked line by line.
export const inactiveReason = (tab: TerminalTab, now: number): string =>
    tab.running ? `last output ${timeAgo(tab.activityAt, { now, days: true })}` : `finished`;
