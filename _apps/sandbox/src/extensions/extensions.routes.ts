import { type ExtensionManifest, extensionIdOf } from "@intentic/extension-api";
import { type ExtensionSummary, extensionsContract } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import { extensionDir, extensionRootOf, readExtensionManifest } from "../capabilities/extension-dirs.js";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";
import { readAllExtensionSettings, writeExtensionSettings } from "./extension-settings.js";

// Installed extensions resolved to their approved manifests + per-extension settings values. The web extension
// host boots from `list`; the bundle bytes ride the plain /extensions/:id/bundle route in app.ts. A checkout
// whose manifest no longer parses is skipped from the list — its capability row still shows status, and
// re-adding repairs it.
export const createExtensionsRoutes = (services: Services) => {
    const i = implement(extensionsContract).$context<OrpcContext>();
    const root = services.workspace.root;
    const manifestOf = async (id: string): Promise<ExtensionManifest | undefined> => {
        const capability = await services.capabilities.get(id);
        if (capability === undefined || capability.kind !== "extension") {
            return undefined;
        }
        return readExtensionManifest(services.files.read, extensionRootOf(extensionDir(root, id), capability.config.path));
    };
    return {
        list: i.list.handler(async () => {
            const capabilities = await services.capabilities.list();
            const extensions: ExtensionSummary[] = [];
            for (const capability of capabilities) {
                if (capability.kind !== "extension") {
                    continue;
                }
                const dir = extensionDir(root, capability.id);
                const manifest = await readExtensionManifest(services.files.read, extensionRootOf(dir, capability.config.path));
                if (manifest === undefined) {
                    continue;
                }
                extensions.push({ id: capability.id, manifest, commit: await services.git.head(dir) });
            }
            return { extensions };
        }),
        settings: i.settings.handler(async ({ input }) => {
            const manifest = await manifestOf(input.id);
            if (manifest === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "no extension with that id" });
            }
            return { settings: (await readAllExtensionSettings(root))[extensionIdOf(manifest)] ?? {} };
        }),
        setSettings: i.setSettings.handler(async ({ input }) => {
            const manifest = await manifestOf(input.id);
            if (manifest === undefined) {
                throw new ORPCError("NOT_FOUND", { message: "no extension with that id" });
            }
            // Only declared keys persist — the manifest is the settings schema, the same honesty rule the host
            // applies to runtime view/command registrations.
            const declared = new Set((manifest.contributes?.settings ?? []).map((setting) => setting.key));
            const undeclared = Object.keys(input.settings).filter((key) => !declared.has(key));
            if (undeclared.length > 0) {
                throw new ORPCError("BAD_REQUEST", { message: `undeclared setting keys: ${undeclared.join(", ")}` });
            }
            await writeExtensionSettings(root, extensionIdOf(manifest), input.settings);
            return { ok: true } as const;
        }),
    };
};
