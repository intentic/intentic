import { z } from "zod";
import { type JsonFile, jsonFile } from "../store/json-file.js";
import { statePath } from "../workspace/state-paths.js";

// Per-extension settings values (<workspace>/.intentic/extension-settings.json), keyed by the manifest-derived
// extension id (publisher.name) — NOT the capability entry id — so values survive a remove/re-add and the
// re-clone that is an update; the checkout dir itself stays pristine. Values are the primitive union the
// contributes.settings descriptors declare.
const FileSchema = z.record(z.string(), z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])));
type SettingsFile = z.infer<typeof FileSchema>;

/* These two are free functions taking a root rather than a store built at composition, so the file object is
 * memoized per root instead. That memo is load-bearing, not a cache: `update`'s write queue lives on the
 * object, so building a fresh one per call would leave two extensions saving at once each reading the old map
 * and the second erasing the first's key — the very lost update the queue exists to stop. One root per process
 * in practice, so this map holds exactly one entry. */
const files = new Map<string, JsonFile<SettingsFile>>();

const settingsFile = (root: string): JsonFile<SettingsFile> => {
    const path = statePath(root, ".intentic/extension-settings.json");
    const existing = files.get(path);
    if (existing !== undefined) {
        return existing;
    }
    const file = jsonFile<SettingsFile>(path, { parse: (raw) => FileSchema.safeParse(raw).data, fallback: () => ({}) });
    files.set(path, file);
    return file;
};

export const readAllExtensionSettings = async (root: string): Promise<SettingsFile> => settingsFile(root).read();

export const writeExtensionSettings = async (root: string, extensionId: string, settings: SettingsFile[string]): Promise<void> => {
    await settingsFile(root).update((all) => ({ ...all, [extensionId]: settings }));
};
