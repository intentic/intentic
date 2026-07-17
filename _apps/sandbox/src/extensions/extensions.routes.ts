import { type ExtensionManifest, extensionIdOf, type ProcessContribution } from "@intentic/extension-api";
import { type ExtensionSummary, extensionsContract, previewUrl, zoneFromUrl } from "@intentic/sandbox-contract";
import { sandboxIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import { implement, ORPCError } from "@orpc/server";
import { extensionDir } from "../capabilities/extension-dirs.js";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";
import { extensionProcessKey, startExtensionProcess } from "./extension-processes.js";
import { readAllExtensionSettings, writeExtensionSettings } from "./extension-settings.js";
import { type InstalledExtension, installedExtensions } from "./installed-extensions.js";

// Installed extensions (git-installed capabilities ∪ image-baked) resolved to their approved manifests +
// per-extension settings values. The web extension host boots from `list`; the bundle bytes ride the plain
// /extensions/:id/bundle route in app.ts. A checkout whose manifest no longer parses is skipped from the list —
// its capability row still shows status, and re-adding repairs it.
export const createExtensionsRoutes = (services: Services) => {
    const i = implement(extensionsContract).$context<OrpcContext>();
    const root = services.workspace.root;
    const zone = services.config.zone !== "" ? services.config.zone : zoneFromUrl(services.config.sandbox.publicUrl);
    const sandboxId = sandboxIdFromToken(services.config.connectToken);
    const find = async (id: string): Promise<InstalledExtension | undefined> => (await installedExtensions(services)).find((e) => e.id === id);
    const manifestOf = async (id: string): Promise<ExtensionManifest | undefined> => (await find(id))?.manifest;
    // The extension + declared process a process route addresses; an undeclared name is NOT_FOUND (the
    // manifest-honesty rule).
    const processOf = async (id: string, name: string): Promise<{ extension: InstalledExtension; process: ProcessContribution }> => {
        const extension = await find(id);
        if (extension === undefined) {
            throw new ORPCError("NOT_FOUND", { message: "no extension with that id" });
        }
        const process = (extension.manifest.contributes?.processes ?? []).find((declared) => declared.name === name);
        if (process === undefined) {
            throw new ORPCError("NOT_FOUND", { message: `the extension declares no process "${name}"` });
        }
        return { extension, process };
    };
    return {
        list: i.list.handler(async () => {
            const extensions: ExtensionSummary[] = [];
            for (const extension of await installedExtensions(services)) {
                // A baked extension has no git checkout — its identity is the shipped image, so commit is a
                // sentinel; a git-installed one reports its pinned HEAD (the bundle route's ETag).
                const commit = extension.builtin ? `builtin` : await services.git.head(extensionDir(root, extension.id));
                extensions.push({ id: extension.id, manifest: extension.manifest, commit, builtin: extension.builtin });
            }
            return { extensions };
        }),
        settings: i.settings.handler(async ({ input }) => {
            const manifest = await manifestOf(input.id);
            if (manifest === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "no extension with that id" });
            }
            const declared = manifest.contributes?.settings ?? [];
            const secretKeys = new Set(declared.filter((setting) => setting.secret === true).map((setting) => setting.key));
            const stored = (await readAllExtensionSettings(root))[extensionIdOf(manifest)] ?? {};
            // Strip secret values from the wire; report which secret keys hold a value so the UI can show "set".
            const settings: Record<string, string | number | boolean> = {};
            const secretsSet: string[] = [];
            for (const [key, value] of Object.entries(stored)) {
                if (secretKeys.has(key)) {
                    if (value !== "") {
                        secretsSet.push(key);
                    }
                } else {
                    settings[key] = value;
                }
            }
            return { settings, secretsSet };
        }),
        setSettings: i.setSettings.handler(async ({ input }) => {
            const manifest = await manifestOf(input.id);
            if (manifest === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "no extension with that id" });
            }
            // Only declared keys persist — the manifest is the settings schema, the same honesty rule the host
            // applies to runtime view/command registrations.
            const declared = manifest.contributes?.settings ?? [];
            const secretKeys = new Set(declared.filter((setting) => setting.secret === true).map((setting) => setting.key));
            const declaredKeys = new Set(declared.map((setting) => setting.key));
            const undeclared = Object.keys(input.settings).filter((key) => !declaredKeys.has(key));
            if (undeclared.length > 0) {
                throw new ORPCError("BAD_REQUEST", { message: `undeclared setting keys: ${undeclared.join(", ")}` });
            }
            // Merge, so a secret key absent from the payload keeps its stored value (the masked UI round-trips
            // non-secret edits without resending secrets); an empty-string secret clears it.
            const stored = (await readAllExtensionSettings(root))[extensionIdOf(manifest)] ?? {};
            const next = { ...stored };
            for (const key of declaredKeys) {
                if (key in input.settings) {
                    next[key] = input.settings[key]!;
                } else if (!secretKeys.has(key)) {
                    delete next[key];
                }
            }
            await writeExtensionSettings(root, extensionIdOf(manifest), next);
            return { ok: true } as const;
        }),
        processStatus: i.processStatus.handler(async ({ input }) => {
            const { process } = await processOf(input.id, input.name);
            const key = extensionProcessKey(input.id, input.name);
            const port = services.processes.portOf(key);
            const url = process.preview === true ? previewUrl(key, zone, sandboxId) : undefined;
            return {
                name: input.name,
                running: services.processes.running(key),
                ...(port !== undefined ? { port } : {}),
                ...(url !== undefined ? { previewUrl: url } : {}),
            };
        }),
        processStart: i.processStart.handler(async ({ input }) => {
            const { extension, process } = await processOf(input.id, input.name);
            await startExtensionProcess(services, extension, process);
            return { ok: true } as const;
        }),
        processStop: i.processStop.handler(async ({ input }) => {
            await processOf(input.id, input.name);
            services.processes.stop(extensionProcessKey(input.id, input.name));
            return { ok: true } as const;
        }),
    };
};
