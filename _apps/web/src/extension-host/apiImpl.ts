import type {
    CapabilityFacts,
    Disposable,
    ExtensionContext,
    IntenticApi,
    ProcessStatus,
    RepoFacts,
    SettingValue,
} from "@intentic/extension-api";
import { extensionApiVersion, extensionIdOf } from "@intentic/extension-api";
import { useTheme } from "@intentic-app/ui";
import type { ExtensionSummary } from "@intentic/sandbox-contract";
import { watch } from "vue";
import { registerCommand, executeCommand } from "../composables/commands/useCommands";
import { extensionSettingsStore } from "../composables/extensions/useExtensionSettings";
import { sandboxJson, sandboxRequest } from "../composables/sandboxClient";
import { registerView } from "../extensions/registry";

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
        commands: {
            register: (command, handler) => {
                const declared = declaredCommands.get(command);
                if (declared === undefined) {
                    throw new Error(`command "${command}" is not declared in the manifest's contributes.commands`);
                }
                return track(registerCommand({ owner: extensionId, command, title: declared.title, icon: declared.icon, handler }));
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
            request: (path, init) => sandboxRequest(path, init),
            json: (path, init) => sandboxJson(path, init),
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
