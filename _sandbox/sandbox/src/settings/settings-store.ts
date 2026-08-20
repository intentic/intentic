import { type SandboxSettings, SandboxSettingsSchema } from "@intentic/sandbox-contract";
import { jsonFile } from "../store/json-file.js";
import { objectParse } from "../store/unknown-keys.js";

// The sandbox-owned agent-settings manifest (<workspace>/.intentic/config/settings.json). Mirrors the automations
// store: a small JSON file the /settings routes edit and streamAgent reads. No secrets, so not on the denylist.

export interface SandboxSettingsStore {
    readonly get: () => Promise<SandboxSettings>;
    readonly set: (settings: SandboxSettings) => Promise<void>;
}

export const fileSandboxSettingsStore = (path: string): SandboxSettingsStore => {
    const file = jsonFile<SandboxSettings>(path, {
        // `objectParse` rather than a bare safeParse: this is the manifest a person is most likely to open and
        // edit, and a misspelled flag would otherwise be stripped in silence and simply never take effect.
        parse: objectParse(SandboxSettingsSchema),
        // Applied when the file is absent or unreadable. The defaults live on the schema (every flag is opt-in,
        // so all default off), so parsing an empty object is the schema's OWN answer for "nothing was written
        // yet" rather than a second copy of the shape that could drift from it. A manifest that predates a flag
        // keeps every pick it DOES carry, the missing key reads as that flag's default.
        fallback: () => SandboxSettingsSchema.parse({}),
    });
    return {
        get: file.read,
        set: async (settings) => {
            await file.update(() => settings);
        },
    };
};
