import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { type SandboxSettings, SandboxSettingsSchema } from "@intentic/sandbox-contract";

// The sandbox-owned agent-settings manifest (<workspace>/.intentic/settings.json). Mirrors the automations
// store: a small JSON file the /settings routes edit and streamAgent reads. No secrets, so not on the denylist.

// Applied when the file is absent or invalid. Every flag is opt-in, so all default off — a fresh sandbox (or an
// older manifest that predates a newly-added flag, which then fails safeParse) reads as everything disabled.
const DEFAULTS: SandboxSettings = {
    searchPastChats: false,
    stableSystemPrompt: false,
    lspTools: false,
    hashlineEdits: false,
    terseOutput: false,
    outputCleaners: "",
    outputHoldout: 0,
    filterBackend: "native",
};

export interface SandboxSettingsStore {
    readonly get: () => Promise<SandboxSettings>;
    readonly set: (settings: SandboxSettings) => Promise<void>;
}

export const fileSandboxSettingsStore = (path: string): SandboxSettingsStore => ({
    get: async () => {
        try {
            const parsed = SandboxSettingsSchema.safeParse(JSON.parse(await readFile(path, "utf8")));
            return parsed.success ? parsed.data : DEFAULTS;
        } catch {
            return DEFAULTS;
        }
    },
    set: async (settings) => {
        await mkdir(dirname(path), { recursive: true });
        await writeFile(path, `${JSON.stringify(settings, undefined, 2)}\n`);
    },
});
