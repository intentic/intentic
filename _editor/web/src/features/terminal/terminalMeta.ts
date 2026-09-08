import type { IconName } from "@intentic/ui";
import { ref, watch } from "vue";
import { useSandbox } from "../sandbox/client/useSandbox";

// Per-terminal cosmetic overrides (label, pill color, pill icon) keyed by tmux session name. Client-side
// preference only, persisted per sandbox in localStorage.

export interface TerminalMeta {
    readonly label?: string;
    readonly color?: TerminalColor;
    readonly icon?: IconName;
}

// Default glyph per KIND; shared by the pills and Recent-work rows so a glyph means one thing everywhere.
export const KIND_ICONS = {
    agent: `sparkles`,
    job: `bolt`,
    process: `cog`,
    shell: `code`,
    panel: `code`,
} as const satisfies Record<string, IconName>;

// Offered pill colors, tuned for the dark pill background.
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

// Icon choices offered in the picker, curated to read at pill size.
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

// Merges patch into the stored meta; a field set to undefined clears that override, and an entry left
// with no fields is dropped.
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

// Drops meta for `web-*` sessions absent from `listed`; other names are kept regardless of state.
export const pruneTerminalMeta = (listed: ReadonlySet<string>): void => {
    const entries = Object.entries(metas.value).filter(([name]) => !name.startsWith(`web-`) || listed.has(name));
    if (entries.length !== Object.keys(metas.value).length) {
        metas.value = Object.fromEntries(entries);
        persist();
    }
};
