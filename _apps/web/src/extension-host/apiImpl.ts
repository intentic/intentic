import type { CapabilityFacts, Disposable, ExtensionContext, IntenticApi, ProcessStatus, RepoFacts } from "@intentic/extension-api";
import { extensionApiVersion, extensionIdOf, flattenQuery, mergeQuery, sandboxRouteAllowed } from "@intentic/extension-api";
import { useDevice, useTheme } from "@intentic/ui";
import { type AgentProvider, type ExtensionSummary, parsePinned, WorkspaceFileSchema } from "@intentic/sandbox-contract";
import { watch } from "vue";
import { requestModelPick } from "../composables/chat/hostModelPicker";
import { modelLabelFor } from "../composables/chat/modelPicker";
import { useChat } from "../composables/chat/useChat";
import { useAgents } from "../composables/agents/useAgents";
import { startAgent } from "../composables/agents/agentActions";
import { registerCommand, executeCommand } from "../composables/commands/useCommands";
import { extensionSettingsStore } from "../composables/extensions/useExtensionSettings";
import { sandboxJson, sandboxRequest } from "../composables/sandbox/sandboxClient";
import { useTerminalPanel } from "../composables/terminal/useTerminalPanel";
import { sandboxKey, useSandbox } from "../composables/sandbox/useSandbox";
import { useWorkspaceTabs } from "../composables/workspace/useWorkspaceTabs";
import { diffTabId } from "../pages/workspace/workspaceTabs";
import { documentProvider, registerDocumentProvider } from "../core-views/documentRegistry";
import { onRefsChanged } from "./refEvents";
import { registerView } from "../core-views/registry";
import { registerViewer } from "../core-views/viewerRegistry";
import { router } from "../router";
import { registerFileBindings } from "./fileBindings";

/* The host's fulfillment of IntenticApi, one instance per activated extension. Every registration is gated on
 * the APPROVED manifest's declarations (views/commands/settings/processes) — the manifest the owner saw at
 * install is the contract; a bundle can't quietly grow surface beyond it. All registrations are tracked on
 * context.subscriptions so deactivation can unwind them. */

// The live workspace facts, bound by useExtensionHost from the panels/capabilities composables (accessor
// functions, so apiImpl needs no vue-query context of its own).
export interface HostBindings {
    readonly repos: () => readonly RepoFacts[];
    readonly capabilities: () => readonly CapabilityFacts[];
    // The sandbox's pinned agent-run model as `${provider}:${model}`, "" when nothing is pinned — the floor
    // `api.models.agentRun()` answers from.
    readonly agentRunModel: () => string;
}

// The live activation of each extension id. An extension is activated ONCE per app load; a second
// createExtensionApi for the same id therefore means the previous activation is being superseded (the dev
// server hot-reloading the host chain, a reload after install/settings change). Retiring it here is what makes
// `context.subscriptions` the deactivation path this file's header promises: without it the old activation's
// views, viewers, commands and settings/workspace/theme watchers all stay live alongside the new ones — a
// second copy of every rail icon, and a listener per re-activation firing on stale state.
const activations = new Map<string, readonly Disposable[]>();

// Retire an extension's live activation. The disposables `track()` collected ARE its whole registration
// surface — views, viewers, commands, file bindings, and the settings/workspace/theme watchers — so this
// unwinds exactly what activate() put in place. Used both to supersede a re-activation and to switch an
// extension off from the Extensions tab without a page reload.
export const deactivateExtension = (extensionId: string): void => {
    for (const disposable of activations.get(extensionId) ?? []) {
        disposable.dispose();
    }
    activations.delete(extensionId);
};

export const createExtensionApi = (
    summary: ExtensionSummary,
    host: HostBindings,
): { readonly api: IntenticApi; readonly context: ExtensionContext } => {
    const extensionId = extensionIdOf(summary.manifest);
    deactivateExtension(extensionId);
    const subscriptions: Disposable[] = [];
    activations.set(extensionId, subscriptions);
    const track = (disposable: Disposable): Disposable => {
        subscriptions.push(disposable);
        return disposable;
    };

    const contributes = summary.manifest.contributes;
    const declaredViews = new Map((contributes?.views ?? []).map((view) => [view.id, view]));
    const declaredViewers = new Map((contributes?.viewers ?? []).map((viewer) => [viewer.id, viewer]));
    const declaredDocuments = new Map((contributes?.documents ?? []).map((document) => [document.id, document]));
    const declaredCommands = new Map((contributes?.commands ?? []).map((command) => [command.command, command]));
    const declaredSettings = contributes?.settings ?? [];
    const declaredProcesses = new Set((contributes?.processes ?? []).map((process) => process.name));

    // The file→view bindings are DECLARATIVE — like settings and processes, there is no runtime register() call
    // for the extension to make. Registering them here means they go live exactly when the host accepts the
    // extension and unwind with its other subscriptions, so the daemon's change push reaches precisely the
    // extensions that are actually running. See fileBindings.ts.
    if (contributes?.files !== undefined) {
        track(registerFileBindings(extensionId, contributes.files));
    }

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
                // The manifest's label is what the install dialog showed — it wins over the runtime value. So
                // does its badge permission: a view the owner never approved to badge simply loses the
                // function, rather than the registration failing — the view itself was approved and still
                // works, it just cannot interrupt from the rail.
                const { badge, ...rest } = view;
                return track(
                    registerView(extensionId, {
                        ...rest,
                        label: declared.label,
                        ...(declared.badge === true && badge !== undefined ? { badge } : {}),
                    }),
                );
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
        documents: {
            register: (provider) => {
                const declared = declaredDocuments.get(provider.id);
                if (declared === undefined) {
                    throw new Error(`document provider "${provider.id}" is not declared in the manifest's contributes.documents`);
                }
                // The family label is the manifest's, like a view's — it is what the install dialog showed. The
                // per-row wording stays with the provider, which is the only thing that knows what it found.
                return track(
                    registerDocumentProvider({
                        owner: extensionId,
                        id: provider.id,
                        label: declared.label,
                        detect: provider.detect,
                        component: provider.view,
                    }),
                );
            },
            // Scoped to this extension's OWN providers, and to a path the provider actually has an offer for —
            // the tab then carries the same title and glyph the tree row would have opened it with, rather than
            // a caller's second guess at them.
            open: (id, path) => {
                const provider = documentProvider(extensionId, id);
                const offer = provider?.detect(path);
                if (provider === undefined || offer === undefined) {
                    return;
                }
                useWorkspaceTabs().openDocument(extensionId, id, path, offer.title, offer.icon);
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
            onDidChangeRefs: (listener) => track(onRefsChanged(listener)),
            /* Opens the tab, then — on mobile only — navigates to it, because the mobile workspace has no tab
             * strip and renders whichever diff `?diff=` names. Same two steps as WorkspaceMobile's own
             * openDiffNav, which is what the app's Changes and History panels go through; an extension must not
             * end up with a diff that exists but is unreachable on a phone. */
            openDiff: (payload) => {
                useWorkspaceTabs().openDiff(payload);
                if (!useDevice().mobile.value) {
                    return;
                }
                const id = diffTabId(payload.key, payload.scope, payload.path);
                void router.push({ name: `workspace`, params: { path: [] }, query: { ...router.currentRoute.value.query, diff: id } });
            },
            // Through guardSandbox and the daemon's own schema, so the manifest grant still applies and the
            // envelope is validated once here instead of in every extension that reads a file.
            file: async (path) => {
                const route = `/workspace/file?path=${encodeURIComponent(path)}`;
                guardSandbox(route);
                try {
                    return WorkspaceFileSchema.parse(await sandboxJson(route)).content;
                } catch {
                    // Absent is the ordinary first state, not an error — see IntenticApi.workspace.file.
                    return undefined;
                }
            },
            readJson: async <T>(path: string): Promise<T | undefined> => {
                const text = await api.workspace.file(path);
                if (text === undefined) {
                    return undefined;
                }
                try {
                    const parsed: unknown = JSON.parse(text);
                    // Asserted, not validated — same contract as `sandbox.json<T>`: the caller names the shape it
                    // expects. What IS checked is that it is a record at all, since a bare array or scalar would
                    // make every property read on it undefined rather than obviously wrong.
                    return typeof parsed === `object` && parsed !== null && !Array.isArray(parsed) ? (parsed as T) : undefined;
                } catch {
                    return undefined;
                }
            },
            write: async (path, body) => {
                const route = `/workspace/upload?path=${encodeURIComponent(path)}`;
                guardSandbox(route, { method: `POST` });
                await sandboxRequest(route, { method: `POST`, body });
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
        chat: {
            // Automation runs now carry stable conversation ids. Prefer the unified registry transcript and
            // retain the history-session fallback for extension callers opening an actual provider session.
            openSession: (id) =>
                void (async () => {
                    const agents = useAgents();
                    if (agents.agentById(id) === undefined) {
                        await agents.loadArchived();
                    }
                    const agent = agents.agentById(id);
                    if (agent !== undefined) {
                        agents.open(agent);
                    } else {
                        await useChat().openConversation(id);
                    }
                })(),
            /* A new chat with the workflow badge already set — `startAgent` is the same call "New agent" makes,
             * so the user lands in the one session-starting surface this product has, with the composer's
             * caret in it and the design named beside the effort control. Nothing is spent until they send. */
            composeWorkflow: (workflowId) => {
                startAgent();
                useChat().active.value.workflowId.value = workflowId;
            },
        },
        /* The shell's own model picker and the default it opens on. Nothing here is gated on a manifest
         * permission: the extension never learns a credential, never reaches a provider route, and cannot
         * observe a catalog it wasn't shown — all it gets back is the pair the user pointed at. */
        models: {
            agentRun: () => {
                // The pin carries the provider with the model, because a model id means nothing without the
                // provider that vends it. Unpinned falls to the owner's own composer, which is what Sandbox ▸
                // Agent ▸ Models calls this row's floor.
                const pinned = parsePinned(host.agentRunModel());
                const chat = useChat();
                const provider = pinned?.provider ?? chat.provider.value;
                const model = pinned?.model ?? chat.model.value;
                return { provider, model, label: modelLabelFor(provider, model) };
            },
            pick: (options) => requestModelPick({ anchor: options.anchor, provider: options.provider as AgentProvider, model: options.model }),
        },
        navigate: (path) => {
            void router.push(path);
        },
        /* `router.currentRoute` rather than `useRoute()`: an extension reads this from a composable that may run
         * outside any component's setup (module state, a lazily-created query), and useRoute() needs injection
         * context. currentRoute is a ref, so reading it inside a computed is reactive either way. */
        route: {
            query: () => flattenQuery(router.currentRoute.value.query),
            setQuery: (patch, options) => {
                const query = mergeQuery(router.currentRoute.value.query, patch);
                void (options?.push === true ? router.push({ query }) : router.replace({ query }));
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
