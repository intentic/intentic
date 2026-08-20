import { z } from "zod";
import { type JsonFile, jsonFile } from "../store/json-file.js";
import { statePath } from "../workspace/state-paths.js";

// The owner's per-extension on/off switch (<workspace>/.intentic/config/extension-enablement.json), keyed by the
// manifest-derived extension id (publisher.name), the same key extension-settings.json uses, so the choice
// survives a remove/re-add and the re-clone that is an update. ABSENT MEANS ENABLED: a fresh sandbox has no
// file at all, and an extension that ships in a later image is on the moment it lands rather than waiting for
// an entry to be written for it.
const FileSchema = z.record(z.string(), z.boolean());
type EnablementFile = z.infer<typeof FileSchema>;

// Memoized per root for the reason extension-settings.ts spells out: `update`'s write queue lives on the file
// object, so building a fresh one per call would let two toggles read the same map and the second erase the
// first's key.
const files = new Map<string, JsonFile<EnablementFile>>();

const enablementFile = (root: string): JsonFile<EnablementFile> => {
    const path = statePath(root, ".intentic/config/extension-enablement.json");
    const existing = files.get(path);
    if (existing !== undefined) {
        return existing;
    }
    const file = jsonFile<EnablementFile>(path, { parse: (raw) => FileSchema.safeParse(raw).data, fallback: () => ({}) });
    files.set(path, file);
    return file;
};

export const readExtensionEnablement = async (root: string): Promise<EnablementFile> => enablementFile(root).read();

export const writeExtensionEnablement = async (root: string, extensionId: string, enabled: boolean): Promise<void> => {
    await enablementFile(root).update((all) => ({ ...all, [extensionId]: enabled }));
};
