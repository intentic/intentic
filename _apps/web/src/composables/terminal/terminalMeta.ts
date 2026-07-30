import type { IconName } from "@intentic-app/ui";
import { ref, watch } from "vue";
import { useSandbox } from "../sandbox/useSandbox";

/* Per-terminal cosmetic overrides (VSCode's Rename / Change Color / Change Icon): a display label, a pill
 * color, and a pill icon, keyed by tmux session name. Pure client-side view state — the tmux session name is
 * the daemon's identity for the socket and kill routes and never changes, so this is a per-browser preference,
 * persisted per sandbox in localStorage. Stable names (a colored `panel-app` dev server) keep their look
 * across restarts; dead web-* entries are pruned on relist since their random names never return. */

export interface TerminalMeta {
    readonly label?: string;
    readonly color?: TerminalColor;
    readonly icon?: IconName;
}

// What each KIND looks like when the user hasn't overridden it — the strip's pills and the Recent-work rows
// read from the same table, so a glyph means the same thing wherever it appears. The browser's globe is the
// one the fetch-category tool cards already use, which is what ties the card offering "watch this" to the pill
// that appears when they do.
export const KIND_ICONS = {
    agent: `sparkles`,
    job: `bolt`,
    process: `cog`,
    shell: `desktop`,
    panel: `desktop`,
    browser: `globe`,
} as const satisfies Record<string, IconName>;

// The offered palette (VSCode's terminal-tab colors, roughly), tuned to read on the dark pill background.
export const TERMINAL_COLORS = {
    red: `#f87171`,
    orange: `#fb923c`,
    yellow: `#facc15`,
    green: `#4ade80`,
    cyan: `#22d3ee`,
    blue: `#60a5fa`,
    purple: `#c084fc`,
    pink: `#f472b6`,
} as const;
export type TerminalColor = keyof typeof TERMINAL_COLORS;

// The icon picker's choices — a curated slice of the app's icon vocabulary that reads at pill size.
export const TERMINAL_ICONS: readonly IconName[] = [
    `desktop`,
    `code`,
    `server`,
    `database`,
    `globe`,
    `cloud`,
    `box`,
    `bolt`,
    `play`,
    `cog`,
    `wifi`,
    `shield`,
    `key`,
    `sitemap`,
    `wave-pulse`,
    `star`,
];

const storageKey = (): string => `ui-terminal-meta-${useSandbox().activeSandboxId.value}`;

const read = (): Record<string, TerminalMeta> => {
    try {
        return JSON.parse(window.localStorage.getItem(storageKey()) ?? `{}`) as Record<string, TerminalMeta>;
    } catch {
        return {};
    }
};

const metas = ref<Record<string, TerminalMeta>>(read());
watch(useSandbox().activeSandboxId, () => {
    metas.value = read();
});

const persist = (): void => {
    try {
        window.localStorage.setItem(storageKey(), JSON.stringify(metas.value));
    } catch {
        // Storage may be unavailable (private mode); the in-memory ref still holds.
    }
};

export const terminalMeta = (name: string): TerminalMeta => metas.value[name] ?? {};

// Merge a patch; an explicitly-undefined field clears its override, and a fully-cleared entry is dropped.
export const setTerminalMeta = (name: string, patch: TerminalMeta): void => {
    const merged: Record<string, string> = {};
    for (const [key, value] of Object.entries({ ...metas.value[name], ...patch })) {
        if (value !== undefined) {
            merged[key] = value;
        }
    }
    const next = { ...metas.value };
    if (Object.keys(merged).length === 0) {
        delete next[name];
    } else {
        next[name] = merged as TerminalMeta;
    }
    metas.value = next;
    persist();
};

// Drop overrides for web-* sessions no longer listed (their random names never return); stable names keep theirs.
export const pruneTerminalMeta = (listed: ReadonlySet<string>): void => {
    const entries = Object.entries(metas.value).filter(([name]) => !name.startsWith(`web-`) || listed.has(name));
    if (entries.length !== Object.keys(metas.value).length) {
        metas.value = Object.fromEntries(entries);
        persist();
    }
};
