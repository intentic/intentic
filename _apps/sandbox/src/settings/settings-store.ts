import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname } from "node:path";
import { type SandboxSettings, SandboxSettingsSchema } from "@intentic/sandbox-contract";

// The sandbox-owned agent-settings manifest (<workspace>/.intentic/settings.json). Mirrors the automations
// store: a small JSON file the /settings routes edit and streamAgent reads. No secrets, so not on the denylist.

// Applied when the file is absent or unreadable. The defaults live on the schema (every flag is opt-in, so all
// default off), so this is the schema's own answer for "nothing was written yet" rather than a second copy of
// the shape that could drift from it. A manifest that predates a flag keeps every pick it DOES carry — the
// missing key reads as that flag's default.
const DEFAULTS: SandboxSettings = SandboxSettingsSchema.parse({});

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
