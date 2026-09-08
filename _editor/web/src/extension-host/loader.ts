import type { ExtensionModule } from "@intentic/extension-api";
import { errorMessage } from "@intentic/ui/async";
import type { ExtensionManifest } from "@intentic/extension-manifest";
import { extensionApiVersion, satisfiesEngines, resetSandboxScope } from "@intentic/extension-api";
import { extensionIdOf } from "@intentic/extension-manifest";
import { type ExtensionSummary, ExtensionsListSchema } from "@intentic/sandbox-contract";
import { shallowRef } from "vue";
import { extensionSettingsStore } from "../features/extensions/useExtensionSettings";
import { sandboxError, sandboxJson, sandboxRequest } from "../features/sandbox/client/sandboxClient";
import { createExtensionApi, deactivateAllExtensions, deactivateExtension, type HostBindings } from "./apiImpl";
import { builtinModules } from "./builtins";

// Loads and activates installed extensions from GET /extensions (compiled-in first-party, daemon-baked, and
// git-installed alike): owner's switch, then engines check, then code.
// A daemon-fetched bundle goes through Blob URL import() (bare import() can't carry the Bearer header), which forces
// single-file ESM bundles.
// Each extension's failure is contained and recorded on a status the Extensions tab renders; the shell never crashes on
// a bad bundle or silently drops one.

export interface ExtensionHostStatus {
    // id is the daemon's capability-entry handle; extensionId is the manifest-derived publisher.name identity.
    readonly id: string;
    readonly extensionId: string;
    // active: running.
    // agent-only: no UI contributions; nothing to activate.
    // disabled: switched off by the owner; the toggle's target state.
    // incompatible / error: engines mismatch, or activate() threw.
    // missing / unlisted: image and bundle disagree, a manifest with no module here, or a module here the daemon
    // doesn't list (still activated, but unswitchable).
    readonly state: "active" | "agent-only" | "disabled" | "incompatible" | "missing" | "unlisted" | "error";
    readonly detail?: string | undefined;
}

export const extensionStatuses = shallowRef<readonly ExtensionHostStatus[]>([]);

// Commit each extension loaded at, per handle; divergence from the current commit triggers the reload prompt.
export const loadedCommits = shallowRef<ReadonlyMap<string, string>>(new Map());

// Whether the load pass finished; a missing tile may simply not have activated yet, not be gone.
export const extensionsLoaded = shallowRef(false);

// Generation counter for the active sandbox, bumped on switch; a stale pass must not finalize anything.
let scope = 0;

// Whether the manifest declares anything to register in the shell.
// UI contributions with no code to run is a defect; none declared is just daemon-side.
const hasUi = (manifest: ExtensionManifest): boolean =>
    (manifest.contributes?.views ?? []).length > 0 ||
    (manifest.contributes?.viewers ?? []).length > 0 ||
    (manifest.contributes?.commands ?? []).length > 0;

// Loads settings first only if the manifest declares any, so compiled-ins with none skip a round-trip; then checks
// startedIn against the current scope.
// Skips activation silently if scope moved (a sandbox switch), since an overtaken pass's report is discarded anyway.
const runActivate = async (summary: ExtensionSummary, host: HostBindings, module: ExtensionModule, startedIn: number): Promise<void> => {
    if ((summary.manifest.contributes?.settings ?? []).length > 0) {
        await extensionSettingsStore(summary.id).load();
    }
    if (startedIn !== scope) {
        return;
    }
    const { api, context } = createExtensionApi(summary, host);
    await module.activate(api, context);
};

// Loads a daemon-hosted bundle via Blob URL, revoked right after import() evaluates it; a single-file bundle has no
// later relative import to resolve.
const importBundle = async (summary: ExtensionSummary): Promise<ExtensionModule> => {
    const path = `/extensions/${encodeURIComponent(summary.id)}/bundle`;
    const response = await sandboxRequest(path);
    if (!response.ok) {
        throw await sandboxError(response, { method: `GET`, path });
    }
    const url = URL.createObjectURL(new Blob([await response.text()], { type: `text/javascript` }));
    try {
        const module = (await import(/* @vite-ignore */ url)) as Partial<ExtensionModule> & { default?: ExtensionModule };
        const resolved = module.default ?? module;
        if (typeof resolved.activate !== `function`) {
            throw new Error(`the bundle exports no activate(api, context)`);
        }
        return resolved as ExtensionModule;
    } finally {
        URL.revokeObjectURL(url);
    }
};

const loadOne = async (summary: ExtensionSummary, host: HostBindings, startedIn: number): Promise<ExtensionHostStatus> => {
    const extensionId = extensionIdOf(summary.manifest);
    const status = { id: summary.id, extensionId };
    // Checked first: a disabled extension must cost neither an engines check nor a bundle fetch.
    if (!summary.enabled) {
        return { ...status, state: `disabled` };
    }
    if (!satisfiesEngines(summary.manifest.engines.intentic, extensionApiVersion)) {
        return {
            ...status,
            state: `incompatible`,
            detail: `needs intentic ${summary.manifest.engines.intentic}; this app provides ${extensionApiVersion}`,
        };
    }
    const compiled = builtinModules.get(extensionId);
    if (compiled === undefined && summary.manifest.entry === undefined) {
        // No module and nothing to fetch: fine if daemon-only; a UI manifest means image and app differ in version.
        return hasUi(summary.manifest)
            ? {
                  ...status,
                  state: `missing`,
                  detail: `declares UI but this app build has no module compiled in for it, the sandbox image and the app are on different versions`,
              }
            : { ...status, state: `agent-only` };
    }
    try {
        await runActivate(summary, host, compiled ?? (await importBundle(summary)), startedIn);
        return { ...status, state: `active` };
    } catch (error) {
        return { ...status, state: `error`, detail: errorMessage(error, String(error)) };
    }
};

// Compiled-in extensions the daemon's list didn't mention (image predates this bundle, or GET /extensions failed).
// Activated anyway from this build; reported as having no switch or settings to live in the daemon.
const loadUnlisted = async (listed: ReadonlySet<string>, host: HostBindings, detail: string, startedIn: number): Promise<ExtensionHostStatus[]> =>
    Promise.all(
        [...builtinModules]
            .filter(([extensionId]) => !listed.has(extensionId))
            .map(async ([extensionId, module]): Promise<ExtensionHostStatus> => {
                const summary: ExtensionSummary = { id: extensionId, manifest: module.manifest, commit: `builtin`, source: `builtin`, enabled: true };
                try {
                    await runActivate(summary, host, module, startedIn);
                    return { id: extensionId, extensionId, state: `unlisted`, detail };
                } catch (error) {
                    return { id: extensionId, extensionId, state: `error`, detail: errorMessage(error, String(error)) };
                }
            }),
    );

// Drops everything this host holds for the current sandbox synchronously, before the new one is asked anything; a later
// re-run would leave stale tiles and a superseded extension running meanwhile.
// Drops the activations, the extensions' own module state, and this module's load record; extensionsLoaded going false
// tells the rail its composition is provisional again.
export const retireExtensions = (): void => {
    scope += 1;
    deactivateAllExtensions();
    resetSandboxScope();
    extensionStatuses.value = [];
    loadedCommits.value = new Map();
    extensionsLoaded.value = false;
};

export const loadExtensions = async (host: HostBindings): Promise<void> => {
    const startedIn = scope;
    // Only fetch caught rather than thrown: on failure, run what's compiled in rather than show nothing.
    let summaries: readonly ExtensionSummary[] = [];
    let listFailure: string | undefined;
    try {
        summaries = ExtensionsListSchema.parse(await sandboxJson(`/extensions`)).extensions;
    } catch (error) {
        listFailure = errorMessage(error, String(error));
    }
    // Bail if the sandbox switched mid-fetch; activating this list would restore tiles the switch just cleared.
    if (startedIn !== scope) {
        return;
    }
    const listed = new Set(summaries.map((summary) => extensionIdOf(summary.manifest)));
    const [listedStatuses, unlistedStatuses] = await Promise.all([
        Promise.all(summaries.map((summary) => loadOne(summary, host, startedIn))),
        loadUnlisted(
            listed,
            host,
            listFailure === undefined
                ? `this sandbox image doesn't list it: the image and the app are on different versions, so it can't be switched off here`
                : `the extension list couldn't be loaded (${listFailure}), activated from this app build alone`,
            startedIn,
        ),
    ]);
    // Anything not running releases what it registered; an active one already replaced its own prior registration.
    for (const status of listedStatuses) {
        if (status.state !== `active`) {
            deactivateExtension(status.extensionId);
        }
    }
    // Bail if scope moved during activation; this pass's report is for a sandbox nobody's looking at now.
    if (startedIn !== scope) {
        return;
    }
    extensionStatuses.value = [...listedStatuses, ...unlistedStatuses];
    loadedCommits.value = new Map(summaries.map((summary) => [summary.id, summary.commit]));
    extensionsLoaded.value = true;
};
