import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { isMissing } from "./runtime.js";

// The plugin's switches: one entry per mechanism, and the single source for both sides of a switch. The manifest's
// `userConfig` is generated from this table (manifest.ts), so each entry is a row in Claude Code's /config; the hooks read
// the chosen values back from `CLAUDE_PLUGIN_OPTION_<KEY>` through `readOptions`, falling back to the same defaults.
// The sandbox's agent-settings page carries the same mechanisms, off by default there because a sandbox pays for them
// on every conversation of every member; here the person installing the plugin has already asked for them.

interface Toggle {
    readonly type: "boolean";
    readonly title: string;
    readonly description: string;
    readonly default: boolean;
}

interface Share {
    readonly type: "number";
    readonly title: string;
    readonly description: string;
    readonly default: number;
    readonly min: number;
    readonly max: number;
}

interface Text {
    readonly type: "string";
    readonly title: string;
    readonly description: string;
    readonly default: string;
}

export const OPTIONS = {
    output_cleaners: {
        type: "boolean",
        title: "Trim Bash output",
        description:
            "Clean what a successful command printed before Claude reads it (progress bars, install chatter, repeated lines, the middle of huge logs), keep the full text retrievable with `retrieve-output`, and ledger what each cleaner saved.",
        default: true,
    },
    cleaners: {
        type: "string",
        title: "Cleaners",
        description:
            "Which cleaners run, as the sandbox spells it: empty for all, `-cap,-wide` to switch some off, `git,pnpm` to allow only those. `/intentic:stats` lists them by what they saved.",
        default: "",
    },
    output_holdout: {
        type: "number",
        title: "Untrimmed share",
        description:
            "Share of commands left untrimmed, so the saving can be measured against a real comparison and not only computed. 0 turns the comparison off; the exact per-command saving is reported either way.",
        default: 0,
        min: 0,
        max: 0.5,
    },
    project_map: {
        type: "boolean",
        title: "Project map",
        description:
            "Open each session with a map of the project it starts in: its areas, what each is for, and where Claude is standing. Worked out from the tree every time, never stored, so it cannot go stale.",
        default: true,
    },
    field_notes: {
        type: "boolean",
        title: "Field notes",
        description:
            "Open each session with this project's field notes: the traps past sessions hit and the commands that really verify. Written by `/intentic:field-notes` from your own sessions here; nothing is sent until you run it once.",
        default: true,
    },
    iq: {
        type: "boolean",
        title: "iq search",
        description:
            "Teach Claude the `iq` code search CLI and recall past sessions on a matching prompt. Needs `npm i -g @intentic/iq`; without it this switch does nothing and says so once.",
        default: true,
    },
    fileq: {
        type: "boolean",
        title: "fileq",
        description:
            "Let Claude read documents, PDFs, spreadsheets, slides, notebooks, images, audio and archives as markdown with the bundled `fileq` CLI. Off makes the command refuse; its one-line skill description stays listed, since a plugin cannot hide its own skills.",
        default: true,
    },
    shadows: {
        type: "boolean",
        title: "Document shadows",
        description:
            "Keep a markdown rendering of every document in the project up to date in the background (a sweep at session start and every ten minutes, and each binary file Claude writes), so a read finds one ready. Costs background CPU on a document-heavy project.",
        default: false,
    },
    holdout: {
        type: "number",
        title: "Measured share",
        description:
            "Share of sessions opened without the map, the field notes and the iq teaching, so `/intentic:stats` can show what each changed. 0 sends them to every session and measures nothing.",
        default: 0.1,
        min: 0,
        max: 0.5,
    },
} as const satisfies Record<string, Toggle | Share | Text>;

export type OptionKey = keyof typeof OPTIONS;

type ValueOf<K extends OptionKey> = (typeof OPTIONS)[K]["type"] extends "boolean" ? boolean : (typeof OPTIONS)[K]["type"] extends "number" ? number : string;

export type Options = { readonly [K in OptionKey]: ValueOf<K> };

// Lenient on purpose: a hook must never fail a session over how a value was spelled, so anything unreadable is the
// default rather than an error.
const asBoolean = (raw: string | undefined, fallback: boolean): boolean => {
    const value = raw?.trim().toLowerCase();
    if (value === "true" || value === "1" || value === "yes" || value === "on") {
        return true;
    }
    if (value === "false" || value === "0" || value === "no" || value === "off") {
        return false;
    }
    return fallback;
};

const asShare = (raw: string | undefined, option: Share): number => {
    const value = raw === undefined || raw.trim() === "" ? Number.NaN : Number(raw);
    return Number.isFinite(value) ? Math.min(option.max, Math.max(option.min, value)) : option.default;
};

export const optionEnvName = (key: OptionKey): string => `CLAUDE_PLUGIN_OPTION_${key.toUpperCase()}`;

// What the person chose in /config, as the hook process received it.
export const readOptions = (env: Readonly<Record<string, string | undefined>> = process.env): Options => {
    const entries = (Object.keys(OPTIONS) as OptionKey[]).map((key) => {
        const option: Toggle | Share | Text = OPTIONS[key];
        const raw = env[optionEnvName(key)];
        if (option.type === "boolean") {
            return [key, asBoolean(raw, option.default)];
        }
        if (option.type === "number") {
            return [key, asShare(raw, option)];
        }
        return [key, raw ?? option.default];
    });
    return Object.fromEntries(entries) as Options;
};

// The switches as the last session started with them, kept beside the ledgers for /intentic:stats. A skill's shell
// command is given no plugin variables, and Claude Code leaves `${user_config.KEY}` unexpanded for an option nobody has
// set, which the Bash tool's permission parser then refuses as a whole command; so the SessionStart hook, which is
// handed every value, writes them down here.
export const optionsFile = (data: string): string => join(data, "options.json");

export const saveOptions = (data: string, options: Options): void => {
    mkdirSync(data, { recursive: true });
    writeFileSync(optionsFile(data), `${JSON.stringify(options)}\n`);
};

// Read back through readOptions, so a saved value is held to the same bounds as a live one; nothing saved yet (the
// plugin has not opened a session) reads as the defaults.
export const loadOptions = (data: string): Options => {
    let text: string;
    try {
        text = readFileSync(optionsFile(data), "utf8");
    } catch (error) {
        if (isMissing(error)) {
            return readOptions({});
        }
        throw error;
    }
    let saved: unknown;
    try {
        saved = JSON.parse(text);
    } catch {
        // A write torn by a crash reads as nothing saved; the next session to open writes the file whole again.
        saved = {};
    }
    const values = typeof saved === "object" && saved !== null ? (saved as Record<string, unknown>) : {};
    return readOptions(Object.fromEntries((Object.keys(OPTIONS) as OptionKey[]).flatMap((key) => (key in values ? [[optionEnvName(key), String(values[key])]] : []))));
};
