import type { CapabilityFacts, Disposable, ExtensionContext, IntenticApi, PickedModel, ProcessStatus, RepoFacts } from "@intentic/extension-api";
import { extensionApiVersion, flattenQuery, mergeQuery } from "@intentic/extension-api";
import { extensionIdOf, sandboxRouteAllowed } from "@intentic/extension-manifest";
import { useDevice, useTheme } from "@intentic/ui";
import { type AgentHarness, type AgentProvider, type ExtensionSummary, sandboxRequestFor, WorkspaceFileSchema } from "@intentic/sandbox-contract";
import { watch } from "vue";
import { effortLabelOf } from "../features/chat/models/effortScale";
import { modelLabelFor } from "../features/chat/accounts/providerCatalog";
import { agentRunChoice, shellModelPicking } from "../features/chat/models/shellModelPicking";
import { summonChat } from "../features/chat/run/summon";
import { useChat } from "../features/chat/run/useChat";
import { accountsOf } from "../features/chat/accounts/useChat-accounts";
import { useAgents } from "../features/agents/fleet/useAgents";
import { startAgent } from "../features/agents/fleet/agentActions";
import { registerCommand, executeCommand } from "../shell/commands/useCommands";
import { extensionSettingsStore } from "../features/extensions/useExtensionSettings";
import { queryClient } from "../lib/queryPersistence";
import { sandboxJson, sandboxRequest } from "../features/sandbox/client/sandboxClient";
import { gatedSandboxRpc } from "../features/sandbox/client/sandboxRpc";
import { useTerminalPanel } from "../features/terminal/useTerminalPanel";
import { sandboxKey } from "../features/sandbox/overview/activeSandbox";
import { useSandbox } from "../features/sandbox/client/useSandbox";
import { useWorkspaceTabs } from "../features/workspace/tabs/useWorkspaceTabs";
import { diffTabId } from "../features/workspace/tabs/workspaceTabs";
import { documentProvider, registerDocumentProvider } from "../core-views/documentRegistry";
import { onFilesChanged } from "./fileEvents";
import { onRefsChanged } from "./refEvents";
import { registerView } from "../core-views/registry";
import { registerViewer } from "../core-views/viewerRegistry";
import { router } from "../router";
import { registerFileBindings } from "./fileBindings";
import { recordSandboxCall } from "./sandboxUsage";
import { uuid } from "../lib/uuid";

// The host's implementation of IntenticApi, one instance per activated extension. Every registration is gated on the
// approved manifest's declarations; all are tracked on context.subscriptions so deactivation can unwind them.

// The live workspace facts, bound by useExtensionHost from the panels/capabilities composables as accessor functions.
export interface HostBindings {
    readonly repos: () => readonly RepoFacts[];
    readonly capabilities: () => readonly CapabilityFacts[];
}

/* WHAT TO CALL A SELECTION, the one place a (provider, model, account, effort) selection is turned into words
 * for an extension, so `pick` and `describe` can never name the same pin two different ways.
 *
 * The account's name is its SIGN-IN IDENTITY where the provider reported one, because that is what the owner
 * recognises: three connections all labelled "Claude" say nothing, and the label is theirs to rename anyway. A
 * pinned id that matches no connected account is left unnamed rather than echoed back, a pin whose credential
 * has been disconnected is exactly what a caller needs to be able to notice.
 *
 * The TIER is named the same way and for the same reason (effortLabelOf): clamped to what this model actually
 * offers, read against the selection's OWN thinking (absent keeps Max on the scale, because the turn then goes
 * out with no thinking field; explicitly off takes it away, because Claude refuses that pair), and left unnamed
 * where the runtime publishes no scale at all. */
// The account half of that, lifted out so the builder below stays one flat literal: which id was pinned, and
// what the owner would recognise it as.
const namedAccount = (provider: AgentProvider, account: string | undefined): Pick<PickedModel, "account" | "accountLabel"> => {
    const connected = account === undefined ? undefined : accountsOf(provider).find((entry) => entry.id === account);
    return {
        ...(account !== undefined ? { account } : {}),
        ...(connected !== undefined ? { accountLabel: connected.email ?? connected.label } : {}),
    };
};

const named = (selection: {
    readonly provider: AgentProvider;
    readonly model: string;
    readonly account?: string | undefined;
    readonly harness?: AgentHarness | undefined;
    readonly effort?: string | undefined;
    readonly thinking?: boolean | undefined;
    readonly fast?: boolean | undefined;
}): PickedModel => {
    const { provider, model, account, harness, effort, thinking, fast } = selection;
    const effortLabel = effortLabelOf(effort, provider, model, thinking);
    return {
        provider,
        model,
        // The one naming rule for a (provider, model) pair, shared with the composer pill and the shell's run buttons.
        label: modelLabelFor(provider, model),
        ...namedAccount(provider, account),
        ...(harness !== undefined ? { harness } : {}),
        ...(effort === undefined || effort === `` ? {} : { effort }),
        ...(effortLabel === undefined ? {} : { effortLabel }),
        ...(thinking !== undefined ? { thinking } : {}),
        ...(fast !== undefined ? { fast } : {}),
    };
};

// Live activation per extension id; a second createExtensionApi for the same id retires the prior one.
const activations = new Map<string, readonly Disposable[]>();

// Retires an extension's live activation: disposes everything `track()` collected (views, viewers, commands, bindings,
// watchers). Used to supersede a re-activation and to switch an extension off without a reload.
export const deactivateExtension = (extensionId: string): void => {
    for (const disposable of activations.get(extensionId) ?? []) {
        disposable.dispose();
    }
    activations.delete(extensionId);
};

// Retires every activation for the one event that invalidates them all: the active sandbox changing. Runs before a load
// pass decides what to activate, since until then every tile on screen still belongs to the old sandbox.
export const deactivateAllExtensions = (): void => {
    // Safe to delete from the map while iterating its keys: a Map iterator visits in insertion order and dropping the
    // current entry skips nothing after it.
    for (const extensionId of activations.keys()) {
        deactivateExtension(extensionId);
    }
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

    // Declarative, like settings and processes: unwinds along with the extension's other subscriptions.
    if (contributes?.files !== undefined) {
        track(registerFileBindings(extensionId, contributes.files));
    }
    // The prefixes `onDidChangeFiles` scopes listeners to, from the approved manifest, so an extension cannot widen
    // what wakes it.
    const declaredFilePaths = (contributes?.files ?? []).map((file) => file.path);

    // Manifest defaults under persisted values; the shared store keeps this and the Extensions tab looking at the same
    // record.
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

    // The manifest's declared sandbox-route allowlist: an undeclared method+path throws, so a bundle can only reach
    // approved daemon routes.
    const sandboxPermissions = summary.manifest.permissions?.sandbox ?? [];
    // The extension's own namespace (`/x/<id>/`) passes ungated, since that is its own code; every other extension's
    // namespace still needs a declaration.
    const ownNamespace = `/x/${summary.id}/`;
    const guardSandbox = (path: string, init?: RequestInit): void => {
        if (path.startsWith(ownNamespace) || path.split(`?`)[0] === ownNamespace.slice(0, -1)) {
            return;
        }
        const method = init?.method ?? `GET`;
        if (!sandboxRouteAllowed(sandboxPermissions, method, path)) {
            throw new Error(
                `extension "${extensionId}" called undeclared sandbox route ${method.toUpperCase()} ${path}: declare it in permissions.sandbox in the manifest`,
            );
        }
        // The gate just decided which declared entry covers this call; kept as the only evidence anywhere that a
        // permission is earned.
        recordSandboxCall(summary.id, sandboxPermissions, method, path);
    };

    // The same gate for a typed call: turns the named procedure into its method and path, then applies the identical
    // allowlist and usage record. A procedure the contract doesn't declare is refused, since reaching it means a
    // hand-built path bypassed the manifest.
    const rpc = gatedSandboxRpc((procedure, input) => {
        const request = sandboxRequestFor(procedure, input);
        if (request === undefined) {
            throw new Error(
                `extension "${extensionId}" called sandbox procedure ${procedure.join(`.`)}, which this build's contract does not declare`,
            );
        }
        guardSandbox(request.path, { method: request.method });
    });

    const { scheme } = useTheme();

    const api: IntenticApi = {
        apiVersion: extensionApiVersion,
        views: {
            register: (view) => {
                const declared = declaredViews.get(view.id);
                if (declared === undefined || declared.surface !== view.surface) {
                    throw new Error(`view "${view.id}" (${view.surface}) is not declared in the manifest's contributes.views`);
                }
                // The manifest's label and badge permission win over the runtime value; a view never approved to badge
                // loses only that function, not the registration.
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
                // File extensions and fetch kind come from the approved manifest; the extension supplies only the
                // component.
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
                // The family label is the manifest's, like a view's; the per-row wording stays with the provider, which
                // is the only thing that knows what it found.
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
            // Scoped to this extension's own providers and to a path it has an offer for; the tab carries the title and
            // glyph the tree row would have used, not the caller's guess.
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
                // Title/icon/keybinding/when all come from the approved manifest, never the runtime call, so the
                // shortcut is bound only as declared and only in the context named.
                return track(
                    registerCommand({
                        owner: extensionId,
                        command,
                        title: declared.title,
                        icon: declared.icon,
                        keybinding: declared.keybinding,
                        when: declared.when,
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
            rpc,
            request: (path, init) => {
                guardSandbox(path, init);
                return sandboxRequest(path, init);
            },
            json: (path, init) => {
                guardSandbox(path, init);
                return sandboxJson(path, init);
            },
            // No guard of its own: whatever `queryFn` reaches for goes through `request`/`json`/`rpc`, which each check
            // the manifest.
            fetch: (query) => queryClient.fetchQuery({ ...query, queryKey: [...query.queryKey] }),
            reachable: () => useSandbox().reachable.value === true,
            key: (...parts) => sandboxKey(...parts),
            origin: () => {
                const base = useSandbox().daemonUrl.value;
                return base === undefined || base === `` ? undefined : base;
            },
            // The same optimistic default useRole makes (`owner` until the platform summary loads); this gates
            // affordances, the daemon gates acts.
            role: () => useSandbox().active.value?.role ?? `owner`,
        },
        workspace: {
            repos: () => host.repos(),
            capabilities: () => host.capabilities(),
            onDidChange: (listener) => {
                const stop = watch([() => host.repos(), () => host.capabilities()], () => listener());
                return track({ dispose: () => stop() });
            },
            onDidChangeRefs: (listener) => track(onRefsChanged(listener)),
            // Scoped to the approved manifest's paths, so an extension declaring nothing is never woken. An empty
            // declaration still returns a live Disposable, since sandboxPoll subscribes unconditionally.
            onDidChangeFiles: (listener) => track(onFilesChanged(declaredFilePaths, listener)),
            // Opens the tab, then on mobile only navigates to it, since the mobile workspace has no tab strip and
            // renders whichever diff `?diff=` names (same as WorkspaceMobile's openDiffNav).
            openDiff: (payload) => {
                // The gesture the extension reports, not a guess: a peek takes the strip's transient slot, a plain open
                // keeps its own tab.
                useWorkspaceTabs().openDiff(payload, payload.preview === true ? `preview` : `keep`);
                if (!useDevice().mobile.value) {
                    return;
                }
                const id = diffTabId(payload.key, payload.scope, payload.path);
                void router.push({ name: `workspace`, params: { path: [] }, query: { ...router.currentRoute.value.query, diff: id } });
            },
            // No navigation or focus change on either device: filling a tab is not a gesture the user made.
            fillDiff: (payload) => useWorkspaceTabs().fillDiff(payload),
            // Through guardSandbox and the daemon's schema, so the manifest grant still applies and the envelope is
            // validated once.
            file: async (path) => {
                const route = `/workspace/file?path=${encodeURIComponent(path)}`;
                guardSandbox(route);
                try {
                    const answer = WorkspaceFileSchema.parse(await sandboxJson(route));
                    // Absent is the ordinary first state, not an error (see IntenticApi.workspace.file).
                    return answer.present ? answer.content : undefined;
                } catch {
                    // A refused or unreachable read; still undefined, since an extension polling a file it lacks a
                    // grant for must not crash its own view.
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
                    // Asserted, not validated, same contract as `sandbox.json<T>`: the caller names the shape it
                    // expects. Checked only that it is a record, since a bare array or scalar would make every property
                    // read undefined silently.
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
            // Prefers the unified registry transcript, falling back to a history-session lookup for callers opening an
            // actual provider session. Both are a summons, so any window may show the result; each path broadcasts its
            // own way.
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
                        const conversationId = uuid();
                        summonChat({
                            kind: `reveal`,
                            verb: `show`,
                            entries: [{ conversationId, sessionRef: id }],
                            focus: conversationId,
                            caret: false,
                        });
                    }
                })(),
            // Open (or focus) the docked chat for a fleet agent by its id, the same thing a card press on
            // the agents board does. The agent's conversation appears in the chat panel rather than
            // navigating away from the current view. Loads the archive if the agent is not in the live
            // roster yet (between a start and the first roster frame, or already archived).
            openAgent: (agentId) =>
                void (async () => {
                    const agents = useAgents();
                    if (agents.agentById(agentId) === undefined) {
                        await agents.loadArchived();
                    }
                    const agent = agents.agentById(agentId);
                    if (agent !== undefined) {
                        agents.open(agent);
                    }
                })(),
            /* A new chat with the workflow badge already set, `startAgent` is the same call "New agent" makes,
             * so the user lands in the one session-starting surface this product has, with the composer's
             * caret in it and the design named beside the effort control. Nothing is spent until they send. */
            composeWorkflow: (workflowId) => {
                startAgent();
                useChat().active.value.workflowId.value = workflowId;
            },
            // The loop badge's half of the same handover: a new chat with the loop picked, waiting for the sentence
            // that becomes its goal.
            composeLoop: (loopId) => {
                startAgent();
                useChat().active.value.loopId.value = loopId;
            },
        },
        // Nothing here is gated on a manifest permission: the extension never learns a credential or reaches a provider
        // route, only the selection the user made and the words for it.
        models: {
            // Both paths read the shell's own selection (shellModelPicking.ts), so an extension's Fix button and the
            // shell's own button always agree on what a click spends. `named` adds `accountLabel`, the field
            // PickedModel carries that AgentRunChoice does not.
            agentRun: (role) => {
                const choice = agentRunChoice(role);
                return named({
                    provider: choice.provider as AgentProvider,
                    model: choice.model,
                    harness: choice.harness as AgentHarness | undefined,
                    effort: choice.effort,
                    thinking: choice.thinking,
                    fast: choice.fast,
                });
            },
            describe: (selection) =>
                named({
                    provider: selection.provider as AgentProvider,
                    model: selection.model,
                    account: selection.account,
                    harness: selection.harness as AgentHarness | undefined,
                    effort: selection.effort,
                    thinking: selection.thinking,
                    fast: selection.fast,
                }),
            pick: async (options) => {
                const choice = await shellModelPicking().pick(options);
                if (choice === undefined) {
                    return undefined;
                }
                return {
                    ...named({
                        provider: choice.provider as AgentProvider,
                        model: choice.model,
                        account: choice.account,
                        harness: choice.harness as AgentHarness | undefined,
                        effort: choice.effort,
                        thinking: choice.thinking,
                        fast: choice.fast,
                    }),
                    // The verb the panel ended with, for a picker opened over an attempt; `named` knows nothing of it.
                    ...(choice.resume !== undefined ? { resume: choice.resume } : {}),
                };
            },
        },
        navigate: (path) => {
            void router.push(path);
        },
        // The address behind the same path, for views whose rows are links rather than buttons.
        href: (path) => router.resolve(path).href,
        // `router.currentRoute` rather than `useRoute()`: an extension may read this outside any component's setup,
        // where `useRoute()` needs injection context; the ref stays reactive inside a computed either way.
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
