import { join } from "node:path";
import { z } from "zod";
import { defineDocument } from "../store/evolution/documents.js";
import type { JsonFile } from "../store/json-file.js";
import { openDocument } from "../store/open-document.js";
import { stateRelPath } from "../state-paths.js";

// The owner's per-extension on/off switch (<workspace>/.intentic/config/extension-enablement.json), keyed by the
// manifest-derived extension id (publisher.name), the same key extension-settings.json uses, so the choice
// survives a remove/re-add and the re-clone that is an update. ABSENT MEANS ENABLED: a fresh sandbox has no
// file at all, and an extension that ships in a later image is on the moment it lands rather than waiting for
// an entry to be written for it.
const FileSchema = z.record(z.string(), z.boolean());
type EnablementFile = z.infer<typeof FileSchema>;

export const extensionEnablementDocument = defineDocument({ path: stateRelPath(".intentic/config/extension-enablement.json"), schema: FileSchema });

// A handle per call: every handle on one path shares its write queue (queueOnFile), so two toggles never read the same
// map and the second erase the first's key.
const enablementFile = (root: string): JsonFile<EnablementFile> =>
    openDocument(extensionEnablementDocument, join(root, extensionEnablementDocument.path), { fallback: () => ({}) });

export const readExtensionEnablement = async (root: string): Promise<EnablementFile> => enablementFile(root).read();

export const writeExtensionEnablement = async (root: string, extensionId: string, enabled: boolean): Promise<void> => {
    await enablementFile(root).update((all) => ({ ...all, [extensionId]: enabled }));
};

// Drops the key entirely, which is not the same as writing `true`: a removed extension that is installed again later
// must come back on the default (enabled), not on whatever the last owner of that id chose.
export const forgetExtensionEnablement = async (root: string, extensionId: string): Promise<void> => {
    await enablementFile(root).update((all) => {
        if (!(extensionId in all)) {
            // By reference, so jsonFile skips the write when there is nothing to drop.
            return all;
        }
        const { [extensionId]: _dropped, ...rest } = all;
        return rest;
    });
};
