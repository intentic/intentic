import { sandboxRef } from "@intentic/extension-api";
import type { IconName } from "@intentic/ui";
import { z } from "zod";
import { useSandbox } from "../../client/sandbox/useSandbox";
import type { TerminalTab } from "./useTerminal";

// Per-terminal cosmetic overrides (label, pill color, pill icon) keyed by tmux session name. Client-side
// preference only, persisted per sandbox in localStorage.

export interface TerminalMeta {
    readonly label?: string;
    readonly color?: TerminalColor;
    readonly icon?: IconName;
}

type TerminalKind = TerminalTab[`kind`];

// Per kind: glyph, whether it is work (tabbed only when shown), whether it is a read-only log view, and its count noun.
export const KINDS = {
    shell: { icon: `code`, work: false, logs: false, noun: [`shell`, `shells`] },
    panel: { icon: `code`, work: false, logs: false, noun: [`dev server`, `dev servers`] },
    agent: { icon: `sparkles`, work: true, logs: false, noun: [`agent shell`, `agent shells`] },
    job: { icon: `bolt`, work: true, logs: false, noun: [`job`, `jobs`] },
    process: { icon: `cog`, work: false, logs: true, noun: undefined },
} as const satisfies Record<TerminalKind, { icon: IconName; work: boolean; logs: boolean; noun: readonly [string, string] | undefined }>;

export const isWork = <T extends { readonly kind: TerminalKind }>(tab: T): tab is T & { readonly kind: `agent` | `job` } => KINDS[tab.kind].work;

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

// What a stored override may hold: a pill color and icon this build offers, and any label. Read per terminal, so one
// entry another build wrote (a color since retired) costs that terminal its override and no other.
const StoredMeta = z.object({
    label: z.string().optional(),
    color: z.enum(Object.keys(TERMINAL_COLORS) as [TerminalColor, ...TerminalColor[]]).optional(),
    icon: z.enum(TERMINAL_ICONS as [IconName, ...IconName[]]).optional(),
});
// An entry that does not read is caught as nothing rather than failing the record.
const StoredMetas = z.record(z.string(), StoredMeta.optional().catch(undefined));

export const parseTerminalMetas = (raw: string | null): Record<string, TerminalMeta> => {
    let stored: Record<string, TerminalMeta | undefined> | undefined;
    try {
        stored = StoredMetas.safeParse(JSON.parse(raw ?? `{}`)).data;
    } catch {
        // allow(silent-catch): an unreadable record is no overrides; the pills draw as they would unnamed.
        return {};
    }
    return Object.fromEntries(Object.entries(stored ?? {}).flatMap(([name, meta]) => (meta === undefined ? [] : [[name, meta] as const])));
};

const read = (): Record<string, TerminalMeta> => {
    try {
        return parseTerminalMetas(window.localStorage.getItem(storageKey()));
    } catch {
        // allow(silent-catch): storage unavailable (private mode) holds no overrides.
        return {};
    }
};

// Each sandbox's own, read back from its key on a switch.
const metas = sandboxRef<Record<string, TerminalMeta>>(() => read());

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
        // SAFETY: `merged` holds only the defined fields of two TerminalMetas spread together.
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
