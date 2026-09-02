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
import { premiumStatus } from "../platform/pool-status.js";
import type { OrpcContext } from "../context.js";
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

// Installed extensions (git-installed capabilities ∪ image-baked) resolved to their approved manifests +
// per-extension settings values. The web extension host boots from `list`; the bundle bytes ride the plain
// /extensions/:id/bundle route in app.ts. A checkout whose manifest no longer parses is skipped from the list,
// its capability row still shows status, and re-adding repairs it.
export const createExtensionsRoutes = (services: Services) => {
    const i = implement(extensionsContract).$context<OrpcContext>();
    const root = services.workspace.root;
    const zone = services.config.zone !== "" ? services.config.zone : zoneFromUrl(services.config.sandbox.publicUrl);
    const sandboxId = sandboxIdFromToken(services.config.connectToken);
    // The same operating-tier gate the capabilities add route holds over installing an extension, because
    // update, revert and unattended-update policy are the same decision: whose code runs here.
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
    // Every id-addressed route resolves through here, against the FULL list, a disabled extension still
    // answers for its settings and its process state, which is what lets the tab render its row.
    const find = async (id: string): Promise<InstalledExtension> => {
        const extension = (await installedExtensions(services)).find((e) => e.id === id);
        if (extension === undefined) {
            throw new ORPCError("NOT_FOUND", { message: "no extension with that id" });
        }
        return extension;
    };
    /* One row's `backend` field, only for a manifest that ships a server bundle. The per-extension answer
     * (running / activation error / absent / incompatible) comes from the supervisor when it has one; while
     * the host itself is between states (starting, restarting after an edit, stopped) the host's own state IS
     * the row's answer, because "your backend is restarting" is the sentence the author needs. A disabled
     * extension reports nothing: its switch is the explanation. */
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
            // Reading the tab is what keeps a watched sandbox's registry comparison current: a stale one
            // refreshes in the background (never on this request's clock) and pushes the list when it lands.
            refreshUpdatesIfStale(services);
            const inventory = await extensionInventory(services);
            // One read for the whole list: the ledger is a single file keyed by extension id, and the tab wants
            // every row's figures at once. Same shape for the update records and the policies.
            const usage = await readExtensionUsage(root);
            const updates = await readExtensionUpdateState(root);
            const policies = await readUpdatePolicies(root);
            const extensions: ExtensionSummary[] = [];
            for (const extension of inventory.extensions) {
                // Only a git-installed extension has a code identity to report, its pinned HEAD. A baked one's
                // identity is the shipped image, and a workspace one's dir is live-edited (the bundle route
                // hashes the bytes it serves), so both get their source as a sentinel.
                const commit = extension.source === "installed" ? await services.git.head(extensionDir(root, extension.id)) : extension.source;
                // Keyed by publisher.name like the settings and the switch, not by the routing id, the ledger
                // has to survive a remove/re-add, which is what an update to a git-installed extension IS.
                const identity = extensionIdOf(extension.manifest);
                const observed = usage[identity];
                // The update lifecycle exists only for the source that HAS one: a git install. The record, the
                // kept-previous checkout and the policy all join here so the row renders the whole story.
                const record = extension.source === "installed" ? updates.extensions[identity] : undefined;
                const previous = extension.source === "installed" ? await previousVersionOf(services, extension.id, undefined) : undefined;
                extensions.push({
                    id: extension.id,
                    manifest: extension.manifest,
                    commit,
                    source: extension.source,
                    enabled: extension.enabled,
                    ...(ESSENTIAL_EXTENSIONS.has(identity) ? { essential: true } : {}),
                    // Absent rather than empty when nothing has been observed: the row must be able to tell
                    // "never exercised" from "exercised and uses none of these".
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
            /* Both halves of "already taken", because they fail differently. An id collision would make the new
             * extension unenumerable, workspace extensions never shadow a baked or installed one, so it would be
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
                throw new ORPCError("CONFLICT", { message: `.intentic/config/workspace-extensions/${input.name} already exists` });
            }
            // The same ping a file the owner wrote through the workspace routes sends, this is their edit, made
            // on their behalf, and the history/commit machinery should see it as one.
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
            // Only declared keys persist, the manifest is the settings schema, the same honesty rule the host
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
            const stored = (await readAllExtensionSettings(root, services.extensionSecretVault))[extensionIdOf(manifest)] ?? {};
            const next = { ...stored };
            for (const key of declaredKeys) {
                if (key in input.settings) {
                    next[key] = input.settings[key]!;
                } else if (!secretKeys.has(key)) {
                    delete next[key];
                }
            }
            /* The split lands here: declared-secret values go to the vault off /work, the rest to the tracked
             * settings file. The read above was rehydrated, so `next` carries whole values and this is the only
             * place that has to know which of them are credentials. */
            await writeExtensionSettings(root, services.extensionSecretVault, extensionIdOf(manifest), next, secretKeys, (id, keys) =>
                services.logger.warn(`extension settings: "${id}" declares ${keys.join(`, `)} secret but stores a non-string`),
            );
            return { ok: true } as const;
        }),
        recordUsage: i.recordUsage.handler(async ({ input }) => {
            const installed = new Map((await installedExtensions(services)).map((extension) => [extension.id, extension]));
            const at = new Date().toISOString();
            /* The manifest filters the batch, the same honesty rule settings follow. A report naming a route the
             * manifest does not declare is not an error anyone can act on, it means the manifest changed while a
             * browser was still running the previous one, so it is dropped rather than refused, and the sweep
             * in the store drops what that browser had already recorded. A removed extension is the same stale
             * browser case and its report is ignored, otherwise the browser would retry it forever. */
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
            // The extension's own directory, for a workspace or baked one that is where it sits, and for a
            // git-installed one it is the checkout, which is what a publisher would push.
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
        // Updating and reverting change the code that runs against the owner's repos and credentials, so like
        // installing they are the owner's decision alone (mirrors the capabilities add route's gate; loopback
        // mode has no auth and skips it like every other route).
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
        // The policy decides what may happen UNATTENDED, operating-tier gated for the same reason the verbs above are.
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
            /* The switch is fixed for a surface whose engine runs regardless (see ESSENTIAL_EXTENSIONS): the
             * scheduler would keep firing turns with the one page that can see, stop or approve them gone. The
             * tab draws these switches as fixed, so this refusal is the backstop for a caller that skipped it. */
            if (!input.enabled && ESSENTIAL_EXTENSIONS.has(extensionIdOf(extension.manifest))) {
                throw new ORPCError("BAD_REQUEST", {
                    message: `${extensionIdOf(extension.manifest)} is the control surface for an engine that runs regardless, it cannot be switched off`,
                });
            }
            /* The premium gate's second door: an installed premium extension that was later disabled (or
             * whose owner's membership lapsed) re-checks at the flip, the same fresh probe the install made.
             * Baked and workspace extensions have no capability entry and no tier, never gated. */
            if (input.enabled) {
                const capability = await services.capabilities.get(input.id);
                if (capability?.kind === "extension" && capability.config.tier === "premium") {
                    const membership = await premiumStatus(services.config);
                    if (!membership.premium) {
                        throw new ORPCError("FORBIDDEN", {
                            message: `this is a premium extension and ${membership.detail ?? "the membership could not be confirmed"}`,
                        });
                    }
                }
            }
            await writeExtensionEnablement(root, extensionIdOf(extension.manifest), input.enabled);
            /* The half of a flip that lands NOW: declared processes. Everything else the switch reaches is
             * rebuilt on its own cadence and needs nothing here, the agent's plugin dirs and PATH are composed
             * per turn (turn-plan.ts), connectors/env/listener providers are read per request, and an
             * `environment` fragment is only in the image. The tab tells the owner which of those an extension
             * actually has, so the delay is stated rather than discovered. */
            if (input.enabled) {
                await startAutoStartProcesses(services, extension);
            } else {
                for (const process of extension.manifest.contributes?.processes ?? []) {
                    services.serviceProcesses.stop(extensionProcessKey(input.id, process.name));
                }
            }
            // A listener extension's gateway is wanted only while its provider is (an enabled automation + a
            // connected capability); the flip changes that answer in both directions.
            void reconcileListenerProcesses(services);
            // The backend half converges the same way: the host restarts on the new enabled set, so a
            // switched-off extension's /x namespace stops answering now rather than at the next boot.
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
            // Stop and status stay reachable while disabled (a lingering process still needs killing); starting
            // one would be the daemon running a contribution the owner switched off.
            if (!extension.enabled) {
                throw new ORPCError("PRECONDITION_FAILED", { message: "the extension is disabled" });
            }
            // The autoStart path skips a runtime-less extension silently (nothing asked for it); a button press
            // asked for it, so it gets the reason instead of a service the supervisor would respawn into the
            // same module-not-found forever.
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
