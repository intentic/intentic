import type { IconName, TooltipValue } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";
import { KINDS, TERMINAL_COLORS, terminalMeta } from "../terminalMeta";
import type { TerminalTab } from "../useTerminal";

// What a pill says about its session: glyph, colour, label and tooltip, the reader's own overrides (terminalMeta) over
// the tab's facts, and an unlabelled shell numbered by its place in the strip's reading order across groups.

// 1-based positions in reading order, splits included.
export const stripIndex = (groups: readonly (readonly string[])[]): Map<string, number> => new Map(groups.flat().map((name, at) => [name, at + 1]));

export const iconFor = (name: string, tab: TerminalTab | undefined): IconName => terminalMeta(name).icon ?? KINDS[tab?.kind ?? `shell`].icon;

export const segmentColor = (name: string): string | undefined => {
    const color = terminalMeta(name).color;
    return color === undefined ? undefined : TERMINAL_COLORS[color];
};

export const labelFor = (name: string, tab: TerminalTab | undefined, position: number | undefined): string =>
    terminalMeta(name).label ?? tab?.label ?? String(position ?? ``);

// The session `delta` steps from the active one in reading order, splits included, wrapping at the ends; none under two.
export const cycled = (groups: readonly (readonly string[])[], active: string | undefined, delta: number): string | undefined => {
    const names = groups.flat();
    return names.length < 2 ? undefined : names[(names.indexOf(active ?? ``) + delta + names.length) % names.length];
};

// What a cleared name resets to, shown as the rename field's placeholder so 'empty resets' is visible.
export const clearedLabel = (tab: TerminalTab | undefined, position: number | undefined): string =>
    tab?.label ?? t(`terminal.stripSegments.numbered`, { position: position ?? `` });

// What a pill says of a session with nothing running right now, by kind.
const idleTooltip = (tab: TerminalTab): TooltipValue => {
    if (tab.kind === `agent`) {
        return tab.running
            ? t(`terminal.stripSegments.aiTerminal`)
            : { title: t(`terminal.stripSegments.aiTerminal`), note: t(`terminal.stripSegments.finished`) };
    }
    if (tab.kind === `job`) {
        return t(`terminal.stripSegments.jobTerminal`);
    }
    return tab.running ? undefined : t(`terminal.stripSegments.finished`);
};

// What is running leads: on a crowded strip the command is the only thing naming the terminal about to be closed.
export const tooltipFor = (tab: TerminalTab | undefined): TooltipValue => {
    if (tab === undefined) {
        return undefined;
    }
    if (KINDS[tab.kind].logs) {
        return { title: t(`terminal.stripSegments.background`), note: t(`terminal.stripSegments.readOnlyLogs`) };
    }
    return tab.command === undefined
        ? idleTooltip(tab)
        : { title: t(`shared.running`), tone: `success`, rows: [{ label: t(`terminal.stripSegments.command`), value: tab.command }] };
};
