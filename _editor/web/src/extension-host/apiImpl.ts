import type { CapabilityFacts, Disposable, ExtensionContext, IntenticApi, PickedModel, ProcessStatus, RepoFacts } from "@intentic/extension-api";
import { extensionApiVersion, flattenQuery, mergeQuery } from "@intentic/extension-api";
import { extensionIdOf, sandboxRouteAllowed } from "@intentic/extension-manifest";
import { useDevice, useTheme } from "@intentic/ui";
import {
    type AgentHarness,
    type AgentProvider,
    type ExtensionSummary,
    sandboxRequestFor,
    WorkspaceFileSchema,
} from "@intentic/sandbox-contract";
import { watch } from "vue";
import { modelLabelFor } from "../composables/chat/providerCatalog";
import { agentRunChoice, shellModelPicking } from "../composables/chat/shellModelPicking";
import { summonChat } from "../composables/chat/summon";
import { accountsOf, useChat } from "../composables/chat/useChat";
import { useAgents } from "../composables/agents/useAgents";
import { startAgent } from "../composables/agents/agentActions";
import { registerCommand, executeCommand } from "../composables/commands/useCommands";
import { extensionSettingsStore } from "../composables/extensions/useExtensionSettings";
import { queryClient } from "../composables/queryPersistence";
import { sandboxJson, sandboxRequest } from "../composables/sandbox/sandboxClient";
import { gatedSandboxRpc } from "../composables/sandbox/sandboxRpc";
import { useTerminalPanel } from "../composables/terminal/useTerminalPanel";
import { sandboxKey } from "../composables/sandbox/activeSandbox";
import { useSandbox } from "../composables/sandbox/useSandbox";
import { useWorkspaceTabs } from "../composables/workspace/useWorkspaceTabs";
import { diffTabId } from "../pages/workspace/workspaceTabs";
import { documentProvider, registerDocumentProvider } from "../core-views/documentRegistry";
import { onFilesChanged } from "./fileEvents";
import { onRefsChanged } from "./refEvents";
import { registerView } from "../core-views/registry";
import { registerViewer } from "../core-views/viewerRegistry";
import { router } from "../router";
import { registerFileBindings } from "./fileBindings";
import { recordSandboxCall } from "./sandboxUsage";
import { uuid } from "../composables/uuid";

/* The host's fulfillment of IntenticApi, one instance per activated extension. Every registration is gated on
 * the APPROVED manifest's declarations (views/commands/settings/processes), the manifest the owner saw at
 * install is the contract; a bundle can't quietly grow surface beyond it. All registrations are tracked on
 * context.subscriptions so deactivation can unwind them. */

// The live workspace facts, bound by useExtensionHost from the panels/capabilities composables (accessor
// functions, so apiImpl needs no vue-query context of its own).
export interface HostBindings {
    readonly repos: () => readonly RepoFacts[];
    readonly capabilities: () => readonly CapabilityFacts[];
}

/* WHAT TO CALL A SELECTION, the one place a (provider, model, account) triple is turned into words for an
 * extension, so `pick` and `describe` can never name the same pin two different ways.
 *
 * The account's name is its SIGN-IN IDENTITY where the provider reported one, because that is what the owner
 * recognises: three connections all labelled "Claude" say nothing, and the label is theirs to rename anyway. A
 * pinned id that matches no connected account is left unnamed rather than echoed back, a pin whose credential
 * has been disconnected is exactly what a caller needs to be able to notice. */
const named = (provider: AgentProvider, model: string, account?: string, harness?: AgentHarness): PickedModel => {
    const connected = account === undefined ? undefined : accountsOf(provider).find((entry) => entry.id === account);
    return {
        provider,
        model,
        // The app's ONE naming rule for a (provider, model) pair, shared with the composer's pill and the shell's
        // own run buttons: an UNPINNED model has no catalog row to name it, and the rule's last rung is the
        // provider's display name, which is right because the provider is what resolves a model at run time.
        label: modelLabelFor(provider, model),
        ...(account !== undefined ? { account } : {}),
        ...(connected !== undefined ? { accountLabel: connected.email ?? connected.label } : {}),
        ...(harness !== undefined ? { harness } : {}),
    };
};

// The live activation of each extension id. An extension is activated ONCE per app load; a second
// createExtensionApi for the same id therefore means the previous activation is being superseded (the dev
// server hot-reloading the host chain, a reload after install/settings change). Retiring it here is what makes
// `context.subscriptions` the deactivation path this file's header promises: without it the old activation's
// views, viewers, commands and settings/workspace/theme watchers all stay live alongside the new ones, a
// second copy of every rail icon, and a listener per re-activation firing on stale state.
const activations = new Map<string, readonly Disposable[]>();

// Retire an extension's live activation. The disposables `track()` collected ARE its whole registration
// surface, views, viewers, commands, file bindings, and the settings/workspace/theme watchers, so this
// unwinds exactly what activate() put in place. Used both to supersede a re-activation and to switch an
// extension off from the Extensions tab without a page reload.
export const deactivateExtension = (extensionId: string): void => {
    for (const disposable of activations.get(extensionId) ?? []) {
        disposable.dispose();
    }
    activations.delete(extensionId);
};

/* Retire ALL of them, for the one event that invalidates every activation at once: the active sandbox changing.
 *
 * Not the same thing as the loader's reconcile, which retires whatever is no longer `active` AFTER a load pass
 * has decided what runs. This runs BEFORE one, and it has to: the extensions a sandbox has installed, and which
 * of them its owner left switched on, are that sandbox's answer. Until the new box has been asked, every tile on
 * screen is the previous box's claim, and every timer still running is polling on its behalf. */
export const deactivateAllExtensions = (): void => {
    // Iterating the live keys while `deactivateExtension` deletes from underneath is safe by specification,
    // a Map iterator visits in insertion order and dropping the entry it is ON skips nothing after it, so
    // there is no snapshot to take, and each id goes out through the one door that unwinds it.
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

    // The file→view bindings are DECLARATIVE, like settings and processes, there is no runtime register() call
    // for the extension to make. Registering them here means they go live exactly when the host accepts the
    // extension and unwind with its other subscriptions, so the daemon's change push reaches precisely the
    // extensions that are actually running. See fileBindings.ts.
    if (contributes?.files !== undefined) {
        track(registerFileBindings(extensionId, contributes.files));
    }
    // The same declaration, as the prefixes `onDidChangeFiles` scopes a listener to. Read once here rather than
    // per subscription: it is the approved manifest's, so an extension cannot widen what it is woken by.
    const declaredFilePaths = (contributes?.files ?? []).map((file) => file.path);

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

    // The manifest's declared sandbox-route allowlist gates every door in api.sandbox: an undeclared
    // method+path throws, so a bundle can only reach the daemon routes the owner approved at install, not the
    // whole daemon.
    const sandboxPermissions = summary.manifest.permissions?.sandbox ?? [];
    /* The extension's OWN backend namespace (/x/<its id>/…) passes with no declaration and no usage record:
     * its backend is its own code from the same approved checkout, so "may this extension talk to itself" is
     * not a grant the owner needs to weigh, and the usage ledger exists to test DECLARED reach. Any other
     * extension's namespace is exactly as foreign as a core route and stays declared. */
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
        // The gate has just decided which of the declared entries covers this call, and that answer is the only
        // evidence anywhere about whether a permission is earned. Kept rather than discarded, see sandboxUsage.
        recordSandboxCall(summary.id, sandboxPermissions, method, path);
    };

    /* The same gate for a TYPED call. The contract turns the procedure the extension named into the method and
     * concrete path it is about to request, and from there this is the check above, verbatim, one allowlist,
     * one usage record, whichever door the extension used.
     *
     * A procedure this build's contract does not declare is refused rather than waved through. It cannot happen
     * through the typed client (there would be nothing to call), so reaching it means the client was handed a
     * hand-built path array, which is precisely the case that must not bypass the manifest. */
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
                // The manifest's label is what the install dialog showed, it wins over the runtime value. So
                // does its badge permission: a view the owner never approved to badge simply loses the
                // function, rather than the registration failing, the view itself was approved and still
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
                // The family label is the manifest's, like a view's, it is what the install dialog showed. The
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
            // Scoped to this extension's OWN providers, and to a path the provider actually has an offer for,
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
                // Title/icon/keybinding/when all come from the approved manifest, never the runtime call, the
                // install dialog is what the user consented to, so the global shortcut is bound only as
                // declared, and only in the context the declaration named.
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
            // No guard of its own: `queryFn` is the extension's, and whatever it reaches for goes through
            // `request`/`json`/`rpc` above, each of which checks the manifest. This is cache plumbing.
            fetch: (query) => queryClient.fetchQuery({ ...query, queryKey: [...query.queryKey] }),
            reachable: () => useSandbox().reachable.value === true,
            key: (...parts) => sandboxKey(...parts),
            origin: () => {
                const base = useSandbox().daemonUrl.value;
                return base === undefined || base === `` ? undefined : base;
            },
            // The same optimistic default useRole makes (`owner` until the platform summary loads, loopback
            // sandboxes never carry one), and for the same reason: this gates affordances, the daemon gates acts.
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
            // Scoped to the APPROVED manifest's paths, so an extension that declared nothing is never woken and
            // one that declared a directory hears about that directory only. An empty declaration still yields a
            // live Disposable: `sandboxPoll` subscribes unconditionally, and a poll with no file binding behind
            // it should degrade to its timer rather than have to ask whether it has one.
            onDidChangeFiles: (listener) => track(onFilesChanged(declaredFilePaths, listener)),
            /* Opens the tab, then, on mobile only, navigates to it, because the mobile workspace has no tab
             * strip and renders whichever diff `?diff=` names. Same two steps as WorkspaceMobile's own
             * openDiffNav, which is what the app's Changes and History panels go through; an extension must not
             * end up with a diff that exists but is unreachable on a phone. */
            openDiff: (payload) => {
                // The gesture the extension is reporting, not this layer's guess: a peek takes the strip's
                // transient slot and is replaced by the next one (a reader going down a commit's file list), a
                // plain open keeps its tab. See DiffPayload.preview.
                useWorkspaceTabs().openDiff(payload, payload.preview === true ? `preview` : `keep`);
                if (!useDevice().mobile.value) {
                    return;
                }
                const id = diffTabId(payload.key, payload.scope, payload.path);
                void router.push({ name: `workspace`, params: { path: [] }, query: { ...router.currentRoute.value.query, diff: id } });
            },
            // No navigation and no focus change, on either device: filling a tab is not a gesture the user made.
            fillDiff: (payload) => useWorkspaceTabs().fillDiff(payload),
            // Through guardSandbox and the daemon's own schema, so the manifest grant still applies and the
            // envelope is validated once here instead of in every extension that reads a file.
            file: async (path) => {
                const route = `/workspace/file?path=${encodeURIComponent(path)}`;
                guardSandbox(route);
                try {
                    const answer = WorkspaceFileSchema.parse(await sandboxJson(route));
                    // Absent is the ordinary first state, not an error, see IntenticApi.workspace.file. The
                    // daemon says so in the body now, so most of what extensions read never reaches the catch.
                    return answer.present ? answer.content : undefined;
                } catch {
                    // A refused or unreachable read. Still undefined here: an extension polling a file it may not
                    // be granted must not take its own view down over it.
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
            // Both roads are a SUMMONS (an extension panel is a surface outside the chat), so the chat showing
            // the result may be any window's, agents.open broadcasts itself, the fallback broadcasts here.
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
            /* A new chat with the workflow badge already set, `startAgent` is the same call "New agent" makes,
             * so the user lands in the one session-starting surface this product has, with the composer's
             * caret in it and the design named beside the effort control. Nothing is spent until they send. */
            composeWorkflow: (workflowId) => {
                startAgent();
                useChat().active.value.workflowId.value = workflowId;
            },
            // The loop badge's half of the same handover, a new chat with the loop picked, waiting for the
            // sentence that becomes its goal.
            composeLoop: (loopId) => {
                startAgent();
                useChat().active.value.loopId.value = loopId;
            },
        },
        /* The shell's own model picker, the default it opens on, and what to call a pin already saved. Nothing
         * here is gated on a manifest permission: the extension never learns a credential, never reaches a
         * provider route, and cannot observe a catalog it wasn't shown, all it gets back is the selection the
         * user pointed at, plus the words for it. An account arrives as its opaque daemon id for the same reason,
         * which is also all the daemon needs to run on it. */
        models: {
            /* Both halves are the SHELL's own (composables/chat/shellModelPicking.ts), not a second reading of
             * the same settings. An extension's Fix button and one the shell draws are the same button, so the
             * day these two disagreed about which model a click spends, one of them would be lying to the user
             * about money. `named` still wraps the answer here because PickedModel carries one field the kit's
             * structural AgentRunChoice does not, accountLabel, which only this side can look up. */
            agentRun: () => {
                const choice = agentRunChoice();
                return named(choice.provider as AgentProvider, choice.model);
            },
            describe: (selection) =>
                named(selection.provider as AgentProvider, selection.model, selection.account, selection.harness as AgentHarness),
            pick: async (options) => {
                const choice = await shellModelPicking().pick(options);
                return choice === undefined
                    ? undefined
                    : named(choice.provider as AgentProvider, choice.model, choice.account, choice.harness as AgentHarness);
            },
        },
        navigate: (path) => {
            void router.push(path);
        },
        // The address behind the same path, for the views whose rows are links rather than buttons.
        href: (path) => router.resolve(path).href,
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
