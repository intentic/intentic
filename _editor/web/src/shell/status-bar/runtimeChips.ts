import type { BrowserSession } from "@intentic/sandbox-contract";
import type { Tip } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";

// THE STATUS BAR'S RUNTIME CHIPS: the machinery agents work with, said at the foot of the window rather than tiled on the
// rail, which is kept for places a reader goes. Each chip is there only while its thing is live (a browser open, an app
// answering, a window on the desktop, a port open to the internet, a tunnel up) or while its page is the one in front,
// so a chip arriving is news and the rail never moves for it. The terminal is the one exception: nothing else opens a
// developer's first shell, so its chip stays.
//
// Pure: the facts come in, the chips go out (useRuntimeChips.ts reads the facts).

export type RuntimeChipId = `terminal` | `preview` | `browsers` | `desktop` | `ports` | `vpn`;

export interface RuntimeChip {
    readonly id: RuntimeChipId;
    /** The words on the chip. */
    readonly label: string;
    /** Where a press goes. Absent for the terminal, whose press opens and closes its panel instead. */
    readonly to?: string;
    /** Drawn beside the label; absent rather than zero. */
    readonly count?: number;
    /** A standing state worth a colour: a browser waiting on the reader, a port the internet can reach, a tunnel up. */
    readonly tone?: `warning` | `success`;
    /** Its page is in front, or for the terminal, its panel is open. */
    readonly active: boolean;
    /** The accessible name: the label, then what the hover card says. */
    readonly aria: string;
    readonly tip: Tip;
}

const spoken = (...parts: readonly (string | undefined)[]): string => parts.filter((part) => part !== undefined && part !== ``).join(`, `);

/** The global terminal: for a developer always, badged with its live sessions. */
export const terminalChip = (facts: {
    readonly count: number;
    readonly summary: string | undefined;
    readonly open: boolean;
    readonly keys: string | undefined;
}): RuntimeChip => {
    const label = t(`shared.terminal`);
    return {
        id: `terminal`,
        label,
        ...(facts.count > 0 ? { count: facts.count } : {}),
        active: facts.open,
        aria: spoken(label, facts.summary) + (facts.keys === undefined ? `` : ` (${facts.keys})`),
        tip: { title: label, keys: facts.keys, rows: facts.summary === undefined ? [] : [{ label: t(`shared.running`), value: facts.summary }] },
    };
};

/**
 * The live app, while something answers. A repo that merely has an operator panel, or files in the outbox, is somewhere
 * to start one from (the palette, the Project page, the chat that started it), not something running.
 */
export const previewChip = (facts: { readonly healthy: number; readonly here: boolean; readonly label: string }): RuntimeChip | undefined => {
    if (facts.healthy === 0 && !facts.here) {
        return undefined;
    }
    const running = facts.healthy > 0 ? t(`shell.shellDesktop.running`, { healthy: facts.healthy }) : undefined;
    return {
        id: `preview`,
        label: facts.label,
        to: `/preview`,
        ...(facts.healthy > 0 ? { count: facts.healthy } : {}),
        active: facts.here,
        aria: spoken(facts.label, running),
        tip: running === undefined ? { title: facts.label } : { title: facts.label, note: running },
    };
};

/**
 * The agents' browsers, while one is open. The daemon keeps a closed one listed for a while as the record of where the
 * agent went; that record is the Browsers page's to show, not news. Warning while one waits on the reader, which the
 * chat's card and Needs you say as well.
 */
export const browsersChip = (facts: { readonly sessions: readonly BrowserSession[]; readonly here: boolean }): RuntimeChip | undefined => {
    const live = facts.sessions.filter((session) => session.running).length;
    const helping = facts.sessions.filter((session) => session.help !== undefined).length;
    if (live === 0 && helping === 0 && !facts.here) {
        return undefined;
    }
    const label = t(`shared.browsers`);
    const base = { id: `browsers`, label, to: `/browsers`, active: facts.here } as const;
    if (helping > 0) {
        const note = t(`shell.shellDesktop.agentNeedsHelp`);
        return { ...base, count: helping, tone: `warning`, aria: spoken(label, note), tip: { title: label, tone: `warn`, note } };
    }
    const open = live > 0 ? t(`shell.shellDesktop.open`, { live }) : undefined;
    return {
        ...base,
        ...(live > 0 ? { count: live } : {}),
        aria: spoken(label, open),
        tip: open === undefined ? { title: label } : { title: label, note: open },
    };
};

/** The sandbox's own desktop, while a window is open on it: an empty screen has nothing to watch. */
export const desktopChip = (facts: { readonly windows: number; readonly here: boolean }): RuntimeChip | undefined => {
    if (facts.windows === 0 && !facts.here) {
        return undefined;
    }
    const label = t(`shared.desktop`);
    const open = facts.windows > 0 ? t(`shell.shellDesktop.windowsOpen`, { count: facts.windows }, facts.windows) : undefined;
    return {
        id: `desktop`,
        label,
        to: `/desktop`,
        ...(facts.windows > 0 ? { count: facts.windows } : {}),
        active: facts.here,
        aria: spoken(label, open),
        tip: open === undefined ? { title: label } : { title: label, note: open },
    };
};

/** Ports forwarded to the internet: the sandbox is answering strangers for as long as this chip is here. */
export const portsChip = (facts: { readonly ports: readonly number[]; readonly here: boolean }): RuntimeChip | undefined => {
    if (facts.ports.length === 0) {
        return undefined;
    }
    const list = facts.ports.join(`, `);
    const title = t(`shell.shellDesktop.publiclyReachable`);
    return {
        id: `ports`,
        label: t(`shell.statusBar.portsPublic`, { port: list, count: facts.ports.length }, facts.ports.length),
        to: `/sandbox/ports`,
        tone: `warning`,
        active: facts.here,
        aria: `${title}: ${list}`,
        tip: { title, tone: `warn`, rows: [{ label: t(`shell.shellDesktop.ports`, {}, facts.ports.length), value: list }] },
    };
};

/** A connected tunnel: while it is up, the sandbox's traffic leaves through someone else's network. */
export const vpnChip = (facts: { readonly names: readonly string[]; readonly here: boolean }): RuntimeChip | undefined => {
    if (facts.names.length === 0) {
        return undefined;
    }
    const names = facts.names.join(`, `);
    const title = t(`shell.shellDesktop.vpnConnected`);
    return {
        id: `vpn`,
        label: t(`shell.statusBar.vpn`),
        to: `/capabilities/vpn`,
        tone: `success`,
        active: facts.here,
        aria: `${title}: ${names}`,
        tip: { title, tone: `ok`, rows: [{ label: t(`shell.shellDesktop.tunnels`, {}, facts.names.length), value: names }] },
    };
};
