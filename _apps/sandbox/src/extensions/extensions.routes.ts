import { type ExtensionManifest, extensionIdOf, type ProcessContribution } from "@intentic/extension-api";
import { type Capability, type ExtensionSummary, extensionsContract, previewUrl, zoneFromUrl } from "@intentic/sandbox-contract";
import { sandboxIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import { implement, ORPCError } from "@orpc/server";
import { extensionDir, extensionRootOf, readExtensionManifest } from "../capabilities/extension-dirs.js";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";
import { declaredProcesses, extensionProcessKey, startExtensionProcess } from "./extension-processes.js";
import { readAllExtensionSettings, writeExtensionSettings } from "./extension-settings.js";

// Installed extensions resolved to their approved manifests + per-extension settings values. The web extension
// host boots from `list`; the bundle bytes ride the plain /extensions/:id/bundle route in app.ts. A checkout
// whose manifest no longer parses is skipped from the list — its capability row still shows status, and
// re-adding repairs it.
export const createExtensionsRoutes = (services: Services) => {
    const i = implement(extensionsContract).$context<OrpcContext>();
    const root = services.workspace.root;
    const zone = services.config.zone !== "" ? services.config.zone : zoneFromUrl(services.config.sandbox.publicUrl);
    const sandboxId = sandboxIdFromToken(services.config.connectToken);
    const manifestOf = async (id: string): Promise<ExtensionManifest | undefined> => {
        const capability = await services.capabilities.get(id);
        if (capability === undefined || capability.kind !== "extension") {
            return undefined;
        }
        return readExtensionManifest(services.files.read, extensionRootOf(extensionDir(root, id), capability.config.path));
    };
    // The capability + declared process a process route addresses; an undeclared name is NOT_FOUND (the
    // manifest-honesty rule).
    const processOf = async (
        id: string,
        name: string,
    ): Promise<{ capability: Extract<Capability, { kind: "extension" }>; process: ProcessContribution }> => {
        const capability = await services.capabilities.get(id);
        if (capability === undefined || capability.kind !== "extension") {
            throw new ORPCError("NOT_FOUND", { message: "no extension with that id" });
        }
        const process = (await declaredProcesses(services, capability)).find((declared) => declared.name === name);
        if (process === undefined) {
            throw new ORPCError("NOT_FOUND", { message: `the extension declares no process "${name}"` });
        }
        return { capability, process };
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
        processStatus: i.processStatus.handler(async ({ input }) => {
            const { process } = await processOf(input.id, input.name);
            const key = extensionProcessKey(input.id, input.name);
            const port = services.panelProcesses.portOf(key);
            const url = process.preview === true ? previewUrl(key, zone, sandboxId) : undefined;
            return {
                name: input.name,
                running: services.panelProcesses.running(key),
                ...(port !== undefined ? { port } : {}),
                ...(url !== undefined ? { previewUrl: url } : {}),
            };
        }),
        processStart: i.processStart.handler(async ({ input }) => {
            const { capability, process } = await processOf(input.id, input.name);
            await startExtensionProcess(services, capability, process);
            return { ok: true } as const;
        }),
        processStop: i.processStop.handler(async ({ input }) => {
            await processOf(input.id, input.name);
            services.panelProcesses.stop(extensionProcessKey(input.id, input.name));
            return { ok: true } as const;
        }),
    };
};
