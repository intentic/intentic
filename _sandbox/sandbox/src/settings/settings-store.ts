import { SETTINGS_HISTORY, type SandboxSettings, SandboxSettingsSchema } from "@intentic/sandbox-contract";
import type { Pin } from "../compliance/org-pins.js";
import { defineDocument } from "../store/evolution/documents.js";
import { openDocument } from "../store/open-document.js";
import { stateRelPath } from "../state-paths.js";

// The sandbox-owned agent-settings manifest (<workspace>/.intentic/config/settings.json). Mirrors the automations
// store: a small JSON file the /settings routes edit and streamAgent reads. No secrets, so not on the denylist.

// Its conversions are the contract's (SETTINGS_HISTORY), shared with a sandbox.toml's [settings] table.
export const settingsDocument = defineDocument({
    path: stateRelPath(".intentic/config/settings.json"),
    schema: SandboxSettingsSchema,
    history: SETTINGS_HISTORY,
});

export interface SandboxSettingsStore {
    readonly get: () => Promise<SandboxSettings>;
    // `get` plus whether the value stands in for a file this build could not read; boot acts on nothing it did not read.
    readonly load: () => Promise<{ readonly settings: SandboxSettings; readonly unreadable: boolean }>;
    readonly set: (settings: SandboxSettings) => Promise<void>;
}

// `pin` is the organisation's (compliance/org-pins.ts): with it, every read is the file with the organisation's pinned values
// applied, a read that finds the file looser writes the pinned values back, and every write is stored pinned. Without
// it (a personal sandbox's composition still passes one; a policy-less pin changes nothing) the file is read as is.
export const fileSandboxSettingsStore = (path: string, pin?: Pin<SandboxSettings>, warn?: (message: string, error: Error) => void): SandboxSettingsStore => {
    const file = openDocument(settingsDocument, path, {
        // Unknown keys reported rather than a bare parse: this is the manifest a person is most likely to open and
        // edit, and a misspelled flag would otherwise be stripped in silence and simply never take effect.
        unknownKeys: true,
        // Applied when the file is absent or unreadable. The defaults live on the schema (every flag is opt-in,
        // so all default off), so parsing an empty object is the schema's OWN answer for "nothing was written
        // yet" rather than a second copy of the shape that could drift from it. A manifest that predates a flag
        // keeps every pick it DOES carry, the missing key reads as that flag's default.
        fallback: () => SandboxSettingsSchema.parse({}),
        // The one manifest the owner edits by hand: a version this build cannot parse is theirs to fix, never replaced.
        onUnreadable: "refuse",
    });
    // The pinned value, converging the file in the background when it was found looser. The convergence re-pins what the
    // file holds by then, under the file's own queue, so it can never write back a value a save replaced meanwhile.
    const pinned = async (stored: SandboxSettings, unreadable: boolean): Promise<SandboxSettings> => {
        if (pin === undefined) {
            return stored;
        }
        const outcome = await pin(stored);
        if (outcome.loosened.length > 0 && !unreadable) {
            void file.update(outcome.reapply).catch((error: Error) => warn?.("settings: writing the organisation's pinned values back failed", error));
        }
        return outcome.value;
    };
    return {
        get: async () => {
            const { value, unreadable } = await file.state();
            return pinned(value, unreadable);
        },
        load: async () => {
            const { value, unreadable } = await file.state();
            return { settings: await pinned(value, unreadable), unreadable };
        },
        set: async (settings) => {
            const stored = pin === undefined ? settings : (await pin(settings)).value;
            await file.update(() => stored);
        },
    };
};
