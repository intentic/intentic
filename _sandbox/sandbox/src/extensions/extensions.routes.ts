import { join } from "node:path";
import { extensionIdOf, type ProcessContribution } from "@intentic/extension-api";
import { type ExtensionSummary, extensionsContract, previewUrl, zoneFromUrl } from "@intentic/sandbox-contract";
import { sandboxIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import { implement, ORPCError } from "@orpc/server";
import { extensionDir, workspaceExtensionsRoot } from "../capabilities/extension-dirs.js";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../context.js";
import { writeExtensionEnablement } from "./extension-enablement.js";
import { extensionProcessKey, reconcileListenerProcesses, startAutoStartProcesses, startExtensionProcess } from "./extension-processes.js";
import { readAllExtensionSettings, writeExtensionSettings } from "./extension-settings.js";
import { readExtensionUsage, recordExtensionUsage } from "./extension-usage.js";
import { extensionInventory, type InstalledExtension, installedExtensions } from "./installed-extensions.js";
import { writeWorkspaceExtension } from "./workspace-extension-scaffold.js";

// Installed extensions (git-installed capabilities ∪ image-baked) resolved to their approved manifests +
// per-extension settings values. The web extension host boots from `list`; the bundle bytes ride the plain
// /extensions/:id/bundle route in app.ts. A checkout whose manifest no longer parses is skipped from the list —
// its capability row still shows status, and re-adding repairs it.
export const createExtensionsRoutes = (services: Services) => {
    const i = implement(extensionsContract).$context<OrpcContext>();
    const root = services.workspace.root;
    const zone = services.config.zone !== "" ? services.config.zone : zoneFromUrl(services.config.sandbox.publicUrl);
    const sandboxId = sandboxIdFromToken(services.config.connectToken);
    // Every id-addressed route resolves through here, against the FULL list — a disabled extension still
    // answers for its settings and its process state, which is what lets the tab render its row.
    const find = async (id: string): Promise<InstalledExtension> => {
        const extension = (await installedExtensions(services)).find((e) => e.id === id);
        if (extension === undefined) {
            throw new ORPCError("NOT_FOUND", { message: "no extension with that id" });
        }
        return extension;
    };
    // The extension + declared process a process route addresses; an undeclared name is NOT_FOUND (the
    // manifest-honesty rule).
    const processOf = async (id: string, name: string): Promise<{ extension: InstalledExtension; process: ProcessContribution }> => {
        const extension = await find(id);
        const process = (extension.manifest.contributes?.processes ?? []).find((declared) => declared.name === name);
        if (process === undefined) {
            throw new ORPCError("NOT_FOUND", { message: `the extension declares no process "${name}"` });
        }
        return { extension, process };
    };
    return {
        list: i.list.handler(async () => {
            const inventory = await extensionInventory(services);
            // One read for the whole list: the ledger is a single file keyed by extension id, and the tab wants
            // every row's figures at once.
            const usage = await readExtensionUsage(root);
            const extensions: ExtensionSummary[] = [];
            for (const extension of inventory.extensions) {
                // Only a git-installed extension has a code identity to report — its pinned HEAD. A baked one's
                // identity is the shipped image, and a workspace one's dir is live-edited (the bundle route
                // hashes the bytes it serves), so both get their source as a sentinel.
                const commit = extension.source === "installed" ? await services.git.head(extensionDir(root, extension.id)) : extension.source;
                // Keyed by publisher.name like the settings and the switch, not by the routing id — the ledger
                // has to survive a remove/re-add, which is what an update to a git-installed extension IS.
                const observed = usage[extensionIdOf(extension.manifest)];
                extensions.push({
                    id: extension.id,
                    manifest: extension.manifest,
                    commit,
                    source: extension.source,
                    enabled: extension.enabled,
                    // Absent rather than empty when nothing has been observed: the row must be able to tell
                    // "never exercised" from "exercised and uses none of these".
                    ...(observed !== undefined && Object.keys(observed).length > 0 ? { usage: observed } : {}),
                });
            }
            return { extensions, invalid: inventory.invalid };
        }),
        create: i.create.handler(async ({ input }) => {
            const id = `${input.publisher}.${input.name}`;
            /* Both halves of "already taken", because they fail differently. An id collision would make the new
             * extension unenumerable — workspace extensions never shadow a baked or installed one, so it would be
             * written, listed as invalid, and never run. A directory collision is somebody's existing work, which
             * may be sitting in `invalid` precisely because they are mid-edit on it. */
            const inventory = await extensionInventory(services);
            if (inventory.extensions.some((extension) => extension.id === id)) {
                throw new ORPCError("CONFLICT", { message: `${id} is already installed here` });
            }
            const dir = join(workspaceExtensionsRoot(root), input.name);
            try {
                await writeWorkspaceExtension(dir, input.publisher, input.name);
            } catch (error) {
                if ((error as NodeJS.ErrnoException).code !== "EEXIST") {
                    throw error;
                }
                throw new ORPCError("CONFLICT", { message: `.intentic/workspace-extensions/${input.name} already exists` });
            }
            // The same ping a file the owner wrote through the workspace routes sends — this is their edit, made
            // on their behalf, and the history/commit machinery should see it as one.
            services.history.notifyUserWrite();
            return { id, dir: `.intentic/workspace-extensions/${input.name}` };
        }),
        settings: i.settings.handler(async ({ input }) => {
            const { manifest } = await find(input.id);
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
            const { manifest } = await find(input.id);
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
        recordUsage: i.recordUsage.handler(async ({ input }) => {
            const extension = await find(input.id);
            /* The manifest filters the batch, the same honesty rule settings follow. A report naming a route the
             * manifest does not declare is not an error anyone can act on — it means the manifest changed while a
             * browser was still running the previous one — so it is dropped rather than refused, and the sweep in
             * the store drops what that browser had already recorded. */
            await recordExtensionUsage(
                root,
                extensionIdOf(extension.manifest),
                extension.manifest.permissions?.sandbox ?? [],
                input.used,
                new Date().toISOString(),
            );
            return { ok: true } as const;
        }),
        setEnabled: i.setEnabled.handler(async ({ input }) => {
            const extension = await find(input.id);
            await writeExtensionEnablement(root, extensionIdOf(extension.manifest), input.enabled);
            /* The half of a flip that lands NOW: declared processes. Everything else the switch reaches is
             * rebuilt on its own cadence and needs nothing here — the agent's plugin dirs and PATH are composed
             * per turn (turn-plan.ts), connectors/env/listener providers are read per request, and an
             * `environment` fragment is only in the image. The tab tells the owner which of those an extension
             * actually has, so the delay is stated rather than discovered. */
            if (input.enabled) {
                await startAutoStartProcesses(services, extension);
            } else {
                for (const process of extension.manifest.contributes?.processes ?? []) {
                    services.processes.stop(extensionProcessKey(input.id, process.name));
                }
            }
            // A listener extension's gateway is wanted only while its provider is (an enabled automation + a
            // connected capability); the flip changes that answer in both directions.
            void reconcileListenerProcesses(services);
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
            // Stop and status stay reachable while disabled (a leftover session still needs killing); starting
            // one would be the daemon running a contribution the owner switched off.
            if (!extension.enabled) {
                throw new ORPCError("PRECONDITION_FAILED", { message: "the extension is disabled" });
            }
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
