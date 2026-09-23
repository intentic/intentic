import type { IconName } from "@intentic/ui";
import { KIND_ICONS, TERMINAL_COLORS, terminalMeta } from "../terminalMeta";
import type { TerminalTab } from "../useTerminal";

// What a pill says about its session: glyph, colour, label and tooltip, the reader's own overrides (terminalMeta) over
// the tab's facts, and an unlabelled shell numbered by its place in the strip's reading order across groups.

// 1-based positions in reading order, splits included.
export const stripIndex = (groups: readonly (readonly string[])[]): Map<string, number> => new Map(groups.flat().map((name, at) => [name, at + 1]));

export const iconFor = (name: string, tab: TerminalTab | undefined): IconName => terminalMeta(name).icon ?? KIND_ICONS[tab?.kind ?? `shell`];

export const segmentColor = (name: string): string | undefined => {
    const color = terminalMeta(name).color;
    return color === undefined ? undefined : TERMINAL_COLORS[color];
};

export const labelFor = (name: string, tab: TerminalTab | undefined, position: number | undefined): string =>
    terminalMeta(name).label ?? tab?.label ?? String(position ?? ``);

// What a cleared name resets to, shown as the rename field's placeholder so 'empty resets' is visible.
export const clearedLabel = (tab: TerminalTab | undefined, position: number | undefined): string => tab?.label ?? `Terminal ${position ?? ``}`;

// What a pill says of a session with nothing running right now, by kind.
const idleTooltip = (tab: TerminalTab): string | undefined => {
    if (tab.kind === `agent`) {
        return tab.running ? `AI terminal` : `AI terminal, finished`;
    }
    if (tab.kind === `job`) {
        return `Job terminal`;
    }
    return tab.running ? undefined : `finished`;
};

// What is running leads: on a crowded strip the command is the only thing naming the terminal about to be closed.
export const tooltipFor = (tab: TerminalTab | undefined): string | undefined => {
    if (tab === undefined) {
        return undefined;
    }
    if (tab.kind === `process`) {
        return `Background process: read-only logs`;
    }
    return tab.command === undefined ? idleTooltip(tab) : `Running ${tab.command}`;
};
