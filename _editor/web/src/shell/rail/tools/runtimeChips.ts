import type { BrowserSession } from "@intentic/sandbox-contract/schemas/terminal";
import type { Tip } from "@intentic/ui";
import { t } from "@intentic/ui/i18n";
import { page, type PageLink } from "../../../lib/routes/links";

// THE RAIL'S TOOL TILES (2026-11-10): the machinery agents work with, as small quiet tiles at the folded rail's foot, over
// the account (RailTools.vue). The terminal and Browsers are always there, so the foot never moves for them: what changes
// is a dot, grey while something is live, amber while an agent waits on the reader. The standing states (a port open to the
// internet, a tunnel up) are tiles only while they hold, and the foot grows upward from the fixed pair, so their arriving
// moves nothing else. The words each chip carries are its hover card and accessible name; the rail draws only the glyph.
//
// Pure: the facts come in, the chips go out (useRuntimeChips.ts reads the facts).

export type RuntimeChipId = `terminal` | `browsers` | `ports` | `vpn`;

export interface RuntimeChip {
    readonly id: RuntimeChipId;
    /** The words on the chip. */
    readonly label: string;
    /**
     * The page a press goes to, made into an address where the reader is (RuntimeChips.vue). Absent for the terminal,
     * whose press opens and closes its panel instead.
     */
    readonly to?: PageLink;
    /** Drawn beside the label; absent rather than zero. */
    readonly count?: number;
    /** A standing state worth a colour: a browser waiting on the reader, a port the internet can reach, a tunnel up. */
    readonly tone?: `warning` | `success`;
    /** Its page is in front, or for the terminal, its panel is open. */
    readonly active: boolean;
    /** The accessible name: the label, then what the hover card says. */
    readonly aria: string;
    /** A hover card when the chip alone does not say enough; omitted when the label and badge already do. */
    readonly tip?: Tip;
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
    const tip =
        facts.keys === undefined && facts.summary === undefined
            ? undefined
            : {
                  title: label,
                  keys: facts.keys,
                  rows: facts.summary === undefined ? [] : [{ label: t(`shared.running`), value: facts.summary }],
              };
    const chip: RuntimeChip = {
        id: `terminal`,
        label,
        ...(facts.count > 0 ? { count: facts.count } : {}),
        active: facts.open,
        aria: spoken(label, facts.summary) + (facts.keys === undefined ? `` : ` (${facts.keys})`),
    };
    if (tip === undefined) {
        return chip;
    }
    return { ...chip, tip };
};

/**
 * Everything live the Browsers view shows, as one chip: the live apps while something answers, the agents' web windows
 * while one is open, the sandbox's desktop while a window is open on it. They are all tabs of one view, so three chips
 * for one place only split the reader's attention; the hover card says what is behind the count. An app counts only
 * while a tab shows it: closing the tab leaves its server running, which the card still says, but the number reads as
 * what is open, and a closed tab is not.
 *
 * A repo that merely has an operator panel is somewhere to start an app from, not something running; a closed browser
 * the daemon still lists is the Browsers page's record, not news. Warning while an agent waits on the reader in one,
 * which the chat's card and Needs you say as well.
 */
interface BrowsersFacts {
    readonly sessions: readonly BrowserSession[];
    /** Live apps answering. */
    readonly apps: number;
    /** Of those, the ones a tab of the view shows; the rest are said on the hover card but not counted. */
    readonly appsOpen: number;
    /** Windows open on the desktop; undefined for a reader who may not drive it. */
    readonly desktopWindows: number | undefined;
    /** What this reader calls a live app (the vocabulary's word). */
    readonly appsLabel: string;
    readonly here: boolean;
}

// The hover card's rows: one per kind that is live.
const browsersRows = (facts: BrowsersFacts, live: number, desktop: number): { label: string; value: string }[] => {
    const rows: { label: string; value: string }[] = [];
    if (facts.apps > 0) {
        rows.push({ label: facts.appsLabel, value: t(`shell.shellDesktop.running`, { healthy: facts.apps }) });
    }
    if (live > 0) {
        rows.push({ label: t(`shared.browsers`), value: t(`shell.shellDesktop.open`, { live }) });
    }
    if (desktop > 0) {
        rows.push({ label: t(`shared.desktop`), value: t(`shell.shellDesktop.windowsOpen`, { count: desktop }, desktop) });
    }
    return rows;
};

// Where a press goes: the window asking for help; else the one kind that is live, by name, since a bare Browsers
// reopens whatever tab was in front; with several kinds live (or none), that tab in front is as good a guess as any. The
// live app is asked for as `?preview`, which the view reads as "pick the one most worth seeing" (BrowsersArea.vue).
const browsersTarget = (facts: BrowsersFacts, desktop: number): PageLink => {
    const asking = facts.sessions.find((session) => session.help !== undefined);
    if (asking !== undefined) {
        return page.browsers(asking.name);
    }
    const window = facts.sessions.find((session) => session.running);
    const kinds = [facts.apps > 0, window !== undefined, desktop > 0].filter(Boolean).length;
    if (kinds !== 1) {
        return page.browsers();
    }
    if (facts.apps > 0) {
        return page.browsers(undefined, { query: { preview: `1` } });
    }
    return page.browsers(window === undefined ? `desktop` : window.name);
};

export const browsersChip = (facts: BrowsersFacts): RuntimeChip => {
    const live = facts.sessions.filter((session) => session.running).length;
    const helping = facts.sessions.filter((session) => session.help !== undefined).length;
    const desktop = facts.desktopWindows ?? 0;
    // The number is what the view has open; an app answering with no tab on it keeps the chip without adding to it.
    const total = facts.appsOpen + live + desktop;
    const label = t(`shared.browsers`);
    const rows = browsersRows(facts, live, desktop);
    const base = { id: `browsers`, label, to: browsersTarget(facts, desktop), active: facts.here } as const;
    if (helping > 0) {
        const note = t(`shell.shellDesktop.agentNeedsHelp`);
        return { ...base, count: helping, tone: `warning`, aria: spoken(label, note), tip: { title: note, tone: `warning`, rows } };
    }
    const chip: RuntimeChip = {
        ...base,
        ...(total > 0 ? { count: total } : {}),
        aria: spoken(label, ...rows.map((row) => `${row.label} ${row.value}`)),
    };
    return rows.length === 0 ? chip : { ...chip, tip: { title: label, rows } };
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
        to: page.sandboxSettings(`ports`),
        tone: `warning`,
        active: facts.here,
        aria: `${title}: ${list}`,
        tip: { title, tone: `warning`, rows: [{ label: t(`shell.shellDesktop.ports`, {}, facts.ports.length), value: list }] },
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
        to: page.capabilities(`vpn`),
        tone: `success`,
        active: facts.here,
        aria: `${title}: ${names}`,
        tip: { title, tone: `success`, rows: [{ label: t(`shell.shellDesktop.tunnels`, {}, facts.names.length), value: names }] },
    };
};
