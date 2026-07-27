import type { CapabilityFacts, Disposable, ExtensionContext, IntenticApi, ProcessStatus, RepoFacts } from "@intentic/extension-api";
import { extensionApiVersion, extensionIdOf, sandboxRouteAllowed } from "@intentic/extension-api";
import { useTheme } from "@intentic-app/ui";
import type { ExtensionSummary } from "@intentic/sandbox-contract";
import { watch } from "vue";
import { registerCommand, executeCommand } from "../composables/commands/useCommands";
import { extensionSettingsStore } from "../composables/extensions/useExtensionSettings";
import { sandboxJson, sandboxRequest } from "../composables/sandbox/sandboxClient";
import { useTerminalPanel } from "../composables/terminal/useTerminalPanel";
import { sandboxKey, useSandbox } from "../composables/sandbox/useSandbox";
import { registerView } from "../core-views/registry";
import { registerViewer } from "../core-views/viewerRegistry";
import { router } from "../router";

/* The host's fulfillment of IntenticApi, one instance per activated extension. Every registration is gated on
 * the APPROVED manifest's declarations (views/commands/settings/processes) — the manifest the owner saw at
 * install is the contract; a bundle can't quietly grow surface beyond it. All registrations are tracked on
 * context.subscriptions so deactivation can unwind them. */

// The live workspace facts, bound by useExtensionHost from the panels/capabilities composables (accessor
// functions, so apiImpl needs no vue-query context of its own).
export interface HostBindings {
    readonly repos: () => readonly RepoFacts[];
    readonly capabilities: () => readonly CapabilityFacts[];
}

export const createExtensionApi = (
    summary: ExtensionSummary,
    host: HostBindings,
): { readonly api: IntenticApi; readonly context: ExtensionContext } => {
    const extensionId = extensionIdOf(summary.manifest);
    const subscriptions: Disposable[] = [];
    const track = (disposable: Disposable): Disposable => {
        subscriptions.push(disposable);
        return disposable;
    };

    const contributes = summary.manifest.contributes;
    const declaredViews = new Map((contributes?.views ?? []).map((view) => [view.id, view]));
    const declaredViewers = new Map((contributes?.viewers ?? []).map((viewer) => [viewer.id, viewer]));
    const declaredCommands = new Map((contributes?.commands ?? []).map((command) => [command.command, command]));
    const declaredSettings = contributes?.settings ?? [];
    const declaredProcesses = new Set((contributes?.processes ?? []).map((process) => process.name));

    // Manifest defaults under the persisted values; the shared store keeps this api and the Sandbox hub's
    // Extensions tab looking at the same record.
    const settingDefaults = Object.fromEntries(
        declaredSettings.flatMap((setting) => (setting.default === undefined ? [] : [[setting.key, setting.default] as const])),
    );
    const declaredSettingKeys = new Set(declaredSettings.map((setting) => setting.key));
    const settings = extensionSettingsStore(summary.id);

    const processPath = (name: string): string => {
        if (!declaredProcesses.has(name)) {
            throw new Error(`process "${name}" is not declared in the manifest's contributes.processes`);
        }
        return `/extensions/${encodeURIComponent(summary.id)}/processes/${encodeURIComponent(name)}`;
    };

    // The manifest's declared sandbox-route allowlist gates api.sandbox.request/json: an undeclared method+path
    // throws, so a bundle can only reach the daemon routes the owner approved at install — not the whole daemon.
    const sandboxPermissions = summary.manifest.permissions?.sandbox ?? [];
    const guardSandbox = (path: string, init?: RequestInit): void => {
        const method = init?.method ?? `GET`;
        if (!sandboxRouteAllowed(sandboxPermissions, method, path)) {
            throw new Error(
                `extension "${extensionId}" called undeclared sandbox route ${method.toUpperCase()} ${path} — declare it in permissions.sandbox in the manifest`,
            );
        }
    };

    const { scheme } = useTheme();

    const api: IntenticApi = {
        apiVersion: extensionApiVersion,
        views: {
            register: (view) => {
                const declared = declaredViews.get(view.id);
                if (declared === undefined || declared.surface !== view.surface) {
                    throw new Error(`view "${view.id}" (${view.surface}) is not declared in the manifest's contributes.views`);
                }
                // The manifest's label is what the install dialog showed — it wins over the runtime value.
                return track(registerView(extensionId, { ...view, label: declared.label }));
            },
        },
        viewers: {
            register: (viewer) => {
                const declared = declaredViewers.get(viewer.id);
                if (declared === undefined) {
                    throw new Error(`viewer "${viewer.id}" is not declared in the manifest's contributes.viewers`);
                }
                // File extensions + fetch kind come from the approved manifest; the extension supplies only the component.
                return track(
                    registerViewer({
                        owner: extensionId,
                        id: viewer.id,
                        extensions: declared.extensions,
                        fetch: declared.fetch,
                        component: viewer.component,
                    }),
                );
            },
        },
        commands: {
            register: (command, handler) => {
                const declared = declaredCommands.get(command);
                if (declared === undefined) {
                    throw new Error(`command "${command}" is not declared in the manifest's contributes.commands`);
                }
                // Title/icon/keybinding all come from the approved manifest, never the runtime call — the install
                // dialog is what the user consented to, so the global shortcut is bound only as declared.
                return track(
                    registerCommand({
                        owner: extensionId,
                        command,
                        title: declared.title,
                        icon: declared.icon,
                        keybinding: declared.keybinding,
                        handler,
                    }),
                );
            },
            execute: (command, ...args) => executeCommand(command, ...args),
        },
        settings: {
            get: (key) => settings.values.value?.[key] ?? settingDefaults[key],
            set: async (key, value) => {
                if (!declaredSettingKeys.has(key)) {
                    throw new Error(`setting "${key}" is not declared in the manifest's contributes.settings`);
                }
                await settings.save({ ...settings.values.value, [key]: value });
            },
            onDidChange: (listener) => {
                let previous = settings.values.value ?? {};
                const stop = watch(settings.values, (next) => {
                    const current = next ?? {};
                    const before = previous;
                    previous = current;
                    for (const key of new Set([...Object.keys(before), ...Object.keys(current)])) {
                        if (before[key] !== current[key]) {
                            listener(key);
                        }
                    }
                });
                return track({ dispose: () => stop() });
            },
        },
        sandbox: {
            request: (path, init) => {
                guardSandbox(path, init);
                return sandboxRequest(path, init);
            },
            json: (path, init) => {
                guardSandbox(path, init);
                return sandboxJson(path, init);
            },
            reachable: () => useSandbox().reachable.value === true,
            key: (...parts) => sandboxKey(...parts),
            origin: () => {
                const base = useSandbox().daemonUrl.value;
                return base === undefined || base === `` ? undefined : base;
            },
        },
        workspace: {
            repos: () => host.repos(),
            capabilities: () => host.capabilities(),
            onDidChange: (listener) => {
                const stop = watch([() => host.repos(), () => host.capabilities()], () => listener());
                return track({ dispose: () => stop() });
            },
        },
        processes: {
            status: (name) => sandboxJson<ProcessStatus>(processPath(name)),
            start: async (name) => {
                await sandboxJson(`${processPath(name)}/start`, { method: `POST` });
            },
            stop: async (name) => {
                await sandboxJson(`${processPath(name)}/stop`, { method: `POST` });
            },
        },
        terminal: {
            open: (session) => useTerminalPanel().openFocused(session),
            setOpen: (open) => useTerminalPanel().setOpen(open),
        },
        navigate: (path) => {
            void router.push(path);
        },
        theme: {
            mode: () => scheme.value,
            onDidChange: (listener) => {
                const stop = watch(scheme, (value) => listener(value));
                return track({ dispose: () => stop() });
            },
        },
    };

    return { api, context: { extensionId, subscriptions } };
};
