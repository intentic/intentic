import { join } from "node:path";
import { errorMessage } from "@intentic/base/errors";
import { extensionApiVersion, satisfiesEngines } from "@intentic/extension-api/protocol";
import { extensionIdOf, type ProcessContribution } from "@intentic/extension-manifest";
import { type ExtensionSummary, extensionsContract, previewUrl, zoneFromUrl } from "@intentic/sandbox-contract";
import { sandboxIdFromToken } from "@intentic/sandbox-contract/tunnel-ids";
import { implement, ORPCError } from "@orpc/server";
import { authorizeMaintainer, bearerFrom } from "../auth/auth.js";
import { extensionDir, workspaceExtensionsRoot } from "../capabilities/extension-dirs.js";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../app-env.js";
import { writeExtensionEnablement } from "./extension-enablement.js";
import { extensionProcessKey, reconcileListenerProcesses, startAutoStartProcesses, startExtensionProcess } from "./extension-processes.js";
import { readAllExtensionSettings, writeExtensionSettings } from "./extension-settings.js";
import { extensionReadiness, extensionRuntimeAbsent, RUNTIME_ABSENT_DETAIL } from "./extension-readiness.js";
import {
    applyExtensionUpdate,
    checkExtensionUpdates,
    previewExtensionUpdate,
    previousVersionOf,
    readExtensionUpdateState,
    readUpdatePolicies,
    refreshUpdatesIfStale,
    resolveUpdatePolicy,
    revertExtensionUpdate,
    writeUpdatePolicy,
} from "./extension-updates.js";
import { readExtensionUsage, recordExtensionUsage } from "./extension-usage.js";
import { ESSENTIAL_EXTENSIONS, extensionInventory, type InstalledExtension, installedExtensions } from "./installed-extensions.js";
import { writeWorkspaceExtension } from "./workspace-extension-scaffold.js";

// Installed extensions (git-installed ∪ image-baked) resolved to manifests and settings; boots the web extension host.
// A checkout whose manifest no longer parses is skipped here; its capability row still shows status until re-added.
export const createExtensionsRoutes = (services: Services) => {
    const i = implement(extensionsContract).$context<OrpcContext>();
    const root = services.workspace.root;
    const zone = services.config.zone !== "" ? services.config.zone : zoneFromUrl(services.config.sandbox.publicUrl);
    const sandboxId = sandboxIdFromToken(services.config.connectToken);
    // Same operating-tier gate the add route holds over installing: update/revert/policy are the same decision.
    const authorizeOperator = async (context: OrpcContext): Promise<void> => {
        if (services.auth === undefined) {
            return;
        }
        try {
            await authorizeMaintainer(services.auth, bearerFrom(context.headers.get("authorization") ?? undefined));
        } catch {
            throw new ORPCError("FORBIDDEN", { message: "only a sandbox maintainer can do this" });
        }
    };
    // Every id-addressed route resolves here against the full list; a disabled extension still renders its row.
    const find = async (id: string): Promise<InstalledExtension> => {
        const extension = (await installedExtensions(services)).find((e) => e.id === id);
        if (extension === undefined) {
            throw new ORPCError("NOT_FOUND", { message: "no extension with that id" });
        }
        return extension;
    };
    // One row's `backend` field, only for a manifest with a server; the supervisor's state wins if present.
    // Otherwise the host's own state (starting/restarting/stopped) answers; a disabled extension reports nothing.
    const backendStateOf = (extension: InstalledExtension): Pick<ExtensionSummary, "backend"> => {
        if (extension.manifest.server === undefined || !extension.enabled) {
            return {};
        }
        const own = services.extensionBackend.statusOf(extension.id);
        if (own !== undefined) {
            return { backend: { state: own.state, ...(own.detail !== undefined ? { detail: own.detail } : {}) } };
        }
        const host = services.extensionBackend.status();
        return {
            backend: { state: host.state === "running" ? "stopped" : host.state, ...(host.detail !== undefined ? { detail: host.detail } : {}) },
        };
    };
    // Extension and declared process a process route addresses; an undeclared name answers NOT_FOUND.
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
            // Refreshes in the background if stale, never on this request's clock; the list updates when it lands.
            refreshUpdatesIfStale(services);
            const inventory = await extensionInventory(services);
            // One read for the whole list: each ledger is one file keyed by id, same shape for updates and policies.
            const usage = await readExtensionUsage(root);
            const updates = await readExtensionUpdateState(root);
            const policies = await readUpdatePolicies(root);
            const extensions: ExtensionSummary[] = [];
            for (const extension of inventory.extensions) {
                // A git-installed extension alone has a pinned HEAD; others use their source as a sentinel.
                const commit = extension.source === "installed" ? await services.git.head(extensionDir(root, extension.id)) : extension.source;
                // Keyed by publisher.name like settings and the switch, surviving a git install's remove/re-add.
                const identity = extensionIdOf(extension.manifest);
                const observed = usage[identity];
                // Update lifecycle exists only for a git install; record, kept-previous checkout and policy join here.
                const record = extension.source === "installed" ? updates.extensions[identity] : undefined;
                const previous = extension.source === "installed" ? await previousVersionOf(services, extension.id, undefined) : undefined;
                extensions.push({
                    id: extension.id,
                    manifest: extension.manifest,
                    commit,
                    source: extension.source,
                    enabled: extension.enabled,
                    ...(ESSENTIAL_EXTENSIONS.has(identity) ? { essential: true } : {}),
                    // Absent, not empty, when unobserved: the row must tell never-exercised from exercised-but-unused.
                    ...(observed !== undefined && Object.keys(observed).length > 0 ? { usage: observed } : {}),
                    ...backendStateOf(extension),
                    ...(record?.update !== undefined ? { update: record.update } : {}),
                    ...(record?.advisory !== undefined ? { advisory: record.advisory } : {}),
                    ...(record?.health !== undefined ? { health: record.health } : {}),
                    ...(previous !== undefined ? { previous } : {}),
                    ...(extension.source === "installed" ? { updatePolicy: resolveUpdatePolicy(policies[identity]) } : {}),
                });
            }
            return {
                extensions,
                invalid: inventory.invalid,
                ...(updates.checkedAt !== undefined ? { updatesCheckedAt: updates.checkedAt } : {}),
            };
        }),
        create: i.create.handler(async ({ input }) => {
            const id = `${input.publisher}.${input.name}`;
            // "Already taken" fails two ways: an id collision leaves it unenumerable, never shadowing a baked one.
            // A directory collision is somebody's existing work, possibly mid-edit and already sitting in `invalid`.
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
                throw new ORPCError("CONFLICT", { message: `.intentic/config/workspace-extensions/${input.name} already exists` });
            }
            // Same ping a workspace file write sends: this is the owner's edit, made on their behalf.
            services.history.notifyUserWrite();
            return { id, dir: `.intentic/config/workspace-extensions/${input.name}` };
        }),
        settings: i.settings.handler(async ({ input }) => {
            const { manifest } = await find(input.id);
            const declared = manifest.contributes?.settings ?? [];
            const secretKeys = new Set(declared.filter((setting) => setting.secret === true).map((setting) => setting.key));
            const stored = (await readAllExtensionSettings(root, services.extensionSecretVault))[extensionIdOf(manifest)] ?? {};
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
            // Only declared keys persist; the manifest is the schema, the honesty rule views/commands also follow.
            const declared = manifest.contributes?.settings ?? [];
            const secretKeys = new Set(declared.filter((setting) => setting.secret === true).map((setting) => setting.key));
            const declaredKeys = new Set(declared.map((setting) => setting.key));
            const undeclared = Object.keys(input.settings).filter((key) => !declaredKeys.has(key));
            if (undeclared.length > 0) {
                throw new ORPCError("BAD_REQUEST", { message: `undeclared setting keys: ${undeclared.join(", ")}` });
            }
            // Merges: a secret key absent from the payload keeps its stored value (masked UI omits resending secrets).
            const stored = (await readAllExtensionSettings(root, services.extensionSecretVault))[extensionIdOf(manifest)] ?? {};
            const next = { ...stored };
            for (const key of declaredKeys) {
                if (key in input.settings) {
                    next[key] = input.settings[key]!;
                } else if (!secretKeys.has(key)) {
                    delete next[key];
                }
            }
            // Split lands here: secret values go to the vault, the rest to the file; `next` holds rehydrated values.
            await writeExtensionSettings(root, services.extensionSecretVault, extensionIdOf(manifest), next, secretKeys, (id, keys) =>
                services.logger.warn(`extension settings: "${id}" declares ${keys.join(`, `)} secret but stores a non-string`),
            );
            return { ok: true } as const;
        }),
        recordUsage: i.recordUsage.handler(async ({ input }) => {
            const installed = new Map((await installedExtensions(services)).map((extension) => [extension.id, extension]));
            const at = new Date().toISOString();
            // Manifest filters the batch: an undeclared route is a stale browser's old manifest, dropped not refused.
            // A removed extension's report is the same stale case, ignored, or the browser would retry it forever.
            await Promise.all(
                Object.entries(input.reports).flatMap(([id, used]) => {
                    const extension = installed.get(id);
                    return extension === undefined
                        ? []
                        : [recordExtensionUsage(root, extensionIdOf(extension.manifest), extension.manifest.permissions?.sandbox ?? [], used, at)];
                }),
            );
            return { ok: true } as const;
        }),
        readiness: i.readiness.handler(async ({ input }) => {
            const extension = await find(input.id);
            const usage = (await readExtensionUsage(root))[extensionIdOf(extension.manifest)];
            // Extension's directory: where it sits for workspace/baked, or the checkout for a git install.
            const checks = await extensionReadiness(extension, satisfiesEngines(extension.manifest.engines.intentic, extensionApiVersion), usage);
            return { checks };
        }),
        checkUpdates: i.checkUpdates.handler(async () => {
            const checkedAt = await checkExtensionUpdates(services);
            return { ok: true, checkedAt } as const;
        }),
        updatePreview: i.updatePreview.handler(async ({ input }) => {
            try {
                return await previewExtensionUpdate(services, input.id, input.ref);
            } catch (error) {
                throw new ORPCError("BAD_REQUEST", { message: errorMessage(error) });
            }
        }),
        // Update/revert change code against the owner's repos and credentials; gated like install, skipped loopback.
        applyUpdate: i.applyUpdate.handler(async ({ input, context }) => {
            await authorizeOperator(context);
            try {
                const applied = await applyExtensionUpdate(services, input.id, input.ref);
                return { ok: true, ref: applied.ref, ...(applied.rebuildNeeded ? { rebuildNeeded: true } : {}) } as const;
            } catch (error) {
                throw new ORPCError("BAD_REQUEST", { message: errorMessage(error) });
            }
        }),
        revert: i.revert.handler(async ({ input, context }) => {
            await authorizeOperator(context);
            try {
                const reverted = await revertExtensionUpdate(services, input.id);
                return { ok: true, ref: reverted.ref } as const;
            } catch (error) {
                throw new ORPCError("BAD_REQUEST", { message: errorMessage(error) });
            }
        }),
        // Decides what may happen unattended; gated for the same reason as the verbs above.
        setUpdatePolicy: i.setUpdatePolicy.handler(async ({ input, context }) => {
            await authorizeOperator(context);
            const extension = await find(input.id);
            if (extension.source !== "installed") {
                throw new ORPCError("PRECONDITION_FAILED", { message: "only a git-installed extension has an update lifecycle" });
            }
            await writeUpdatePolicy(root, extensionIdOf(extension.manifest), {
                ...(input.updates !== undefined ? { updates: input.updates } : {}),
                ...(input.advisories !== undefined ? { advisories: input.advisories } : {}),
            });
            return { ok: true } as const;
        }),
        setEnabled: i.setEnabled.handler(async ({ input }) => {
            const extension = await find(input.id);
            // Switch is fixed for a surface whose engine runs regardless: the scheduler fires with nothing to stop it.
            // The tab draws these switches as fixed; this refusal backstops a caller that skipped it.
            if (!input.enabled && ESSENTIAL_EXTENSIONS.has(extensionIdOf(extension.manifest))) {
                throw new ORPCError("BAD_REQUEST", {
                    message: `${extensionIdOf(extension.manifest)} is the control surface for an engine that runs regardless, it cannot be switched off`,
                });
            }
            await writeExtensionEnablement(root, extensionIdOf(extension.manifest), input.enabled);
            // Only declared processes land now; everything else the switch reaches rebuilds on its own cadence.
            // The tab states which of those an extension has, rather than leave the delay to be discovered.
            if (input.enabled) {
                await startAutoStartProcesses(services, extension);
            } else {
                for (const process of extension.manifest.contributes?.processes ?? []) {
                    services.serviceProcesses.stop(extensionProcessKey(input.id, process.name));
                }
            }
            // A listener gateway is wanted only while its provider is: an enabled automation, a connected capability.
            void reconcileListenerProcesses(services);
            // Backend converges the same way: the host restarts on the new set, so /x stops answering now, not later.
            services.extensionBackend.restart();
            return { ok: true } as const;
        }),
        processStatus: i.processStatus.handler(async ({ input }) => {
            const { process } = await processOf(input.id, input.name);
            const key = extensionProcessKey(input.id, input.name);
            const service = services.serviceProcesses.statusOf(key);
            const url = process.preview === true ? previewUrl(key, zone, sandboxId) : undefined;
            return {
                name: input.name,
                running: service?.state === "running",
                ...(service !== undefined ? { port: service.port, restarts: service.restarts } : {}),
                ...(service?.lastExitCode !== undefined ? { lastExitCode: service.lastExitCode } : {}),
                ...(url !== undefined ? { previewUrl: url } : {}),
            };
        }),
        processStart: i.processStart.handler(async ({ input }) => {
            const { extension, process } = await processOf(input.id, input.name);
            // Stop/status stay reachable while disabled (a lingering process needs killing); starting one would not.
            if (!extension.enabled) {
                throw new ORPCError("PRECONDITION_FAILED", { message: "the extension is disabled" });
            }
            // autoStart skips a runtime-less extension silently; a button press gets the reason, not a respawn loop.
            if (await extensionRuntimeAbsent(extension)) {
                throw new ORPCError("PRECONDITION_FAILED", { message: `this extension's code is ${RUNTIME_ABSENT_DETAIL}` });
            }
            await startExtensionProcess(services, extension, process);
            return { ok: true } as const;
        }),
        processStop: i.processStop.handler(async ({ input }) => {
            await processOf(input.id, input.name);
            services.serviceProcesses.stop(extensionProcessKey(input.id, input.name));
            return { ok: true } as const;
        }),
    };
};
