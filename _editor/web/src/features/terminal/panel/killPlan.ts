import { KINDS } from "../terminalMeta";
import type { TerminalTab } from "../useTerminal";

// Whether killing terminals asks first, and what the question names: a kill confirms only where there is something to
// lose, a busy session or two-or-more live ones at once. `command`, never `running`, says busy: a user's shell is
// always running, and a guard keyed on that would fire on every close and teach the reader to click through it.

// A session with work in it; a process tab's × closes a view, not a session, so it is never busy.
export const hasWork = (tab: TerminalTab | undefined): boolean => tab !== undefined && !KINDS[tab.kind].logs && tab.command !== undefined;

const busyIn = (order: readonly TerminalTab[], names: readonly string[]): TerminalTab[] =>
    order.filter((tab) => names.includes(tab.name) && hasWork(tab));

const runningIn = (order: readonly TerminalTab[], names: readonly string[]): TerminalTab[] =>
    order.filter((tab) => names.includes(tab.name) && tab.running);

// Whether the press is the whole decision: false for nothing busy among one session, or nothing live among many.
export const killAsks = (order: readonly TerminalTab[], names: readonly string[]): boolean =>
    busyIn(order, names).length > 0 || (names.length !== 1 && runningIn(order, names).length > 0);

export interface KillQuestion {
    readonly header: string;
    readonly body: string;
    // What the dialog lists: the busy sessions if that is why it opened, else the live ones the kill ends; never both.
    readonly items: readonly TerminalTab[];
}

const headerOf = (busy: readonly TerminalTab[], items: readonly TerminalTab[]): string => {
    if (busy.length === 1) {
        // The command IS the question; cut short, since a session can be running something with a long name.
        return `Kill the terminal running ${(busy[0]?.command ?? ``).slice(0, 24)}?`;
    }
    if (busy.length > 1) {
        return `Kill ${busy.length} busy terminals?`;
    }
    return items.length === 1 ? `Kill the running terminal?` : `Kill ${items.length} running terminals?`;
};

export const killQuestion = (order: readonly TerminalTab[], names: readonly string[]): KillQuestion => {
    const busy = busyIn(order, names);
    const items = busy.length > 0 ? busy : runningIn(order, names);
    return {
        header: headerOf(busy, items),
        body:
            busy.length > 0
                ? `This stops what ${busy.length === 1 ? `it is` : `they are`} doing. Scrollback goes with it, and there is no undo.`
                : `Killing these ends whatever they are running. Scrollback goes with them.`,
        items,
    };
};
