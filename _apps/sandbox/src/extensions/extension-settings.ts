import { mkdir, readFile, writeFile } from "node:fs/promises";
import { dirname, join } from "node:path";
import { z } from "zod";

// Per-extension settings values (<workspace>/.intentic/extension-settings.json), keyed by the manifest-derived
// extension id (publisher.name) — NOT the capability entry id — so values survive a remove/re-add and the
// re-clone that is an update; the checkout dir itself stays pristine. Values are the primitive union the
// contributes.settings descriptors declare.
const FileSchema = z.record(z.string(), z.record(z.string(), z.union([z.string(), z.number(), z.boolean()])));
type SettingsFile = z.infer<typeof FileSchema>;

const settingsPath = (root: string): string => join(root, ".intentic", "extension-settings.json");

export const readAllExtensionSettings = async (root: string): Promise<SettingsFile> => {
    try {
        const parsed = FileSchema.safeParse(JSON.parse(await readFile(settingsPath(root), "utf8")));
        return parsed.success ? parsed.data : {};
    } catch {
        return {};
    }
};

export const writeExtensionSettings = async (root: string, extensionId: string, settings: SettingsFile[string]): Promise<void> => {
    const all = await readAllExtensionSettings(root);
    const path = settingsPath(root);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, `${JSON.stringify({ ...all, [extensionId]: settings }, undefined, 2)}\n`);
};
