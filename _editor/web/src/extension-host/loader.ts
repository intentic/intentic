import type { ExtensionModule } from "@intentic/extension-api";
import { messageOr } from "@intentic/ui/async";
import { t } from "@intentic/ui/i18n";
import { registerExtensionMessages } from "@intentic/extension-ui/i18n";
import type { ExtensionManifest } from "@intentic/extension-manifest";
import { extensionApiVersion, satisfiesEngines } from "@intentic/extension-api";
import { extensionIdOf } from "@intentic/extension-manifest";
import type { ExtensionSummary } from "@intentic/sandbox-contract/schemas/extension-updates";
import { shallowRef } from "vue";
import { type ExtensionHostStatus, extensionsLoaded, extensionStatuses } from "../workbench/views/extensionStatuses";
import { extensionSettingsStore } from "../features/extensions/useExtensionSettings";
import { sandboxError, sandboxRequest } from "../client/sandbox/sandboxClient";
import { sandboxRpc } from "../client/sandbox/sandboxRpc";
import { readFailure } from "../client/sandbox/useDaemonRoutes";
import { createExtensionApi, deactivateAllExtensions, deactivateExtension, type HostBindings } from "./apiImpl";
import { builtinModules } from "./builtins";
import { bundleLinkProblem } from "./bundleLinks";
import { codeRevisionOf } from "../features/extensions/codeRevision";
import { LOCAL_EXTENSIONS, localFace } from "../app/environments/local";
import { type ReportFields, reportClient } from "../app/clientDiagnostics";

// Loads and activates installed extensions from GET /extensions (compiled-in first-party, daemon-baked, and
// git-installed alike): owner's switch, then engines check, then the bundle's imports against what the host exports
// (bundleLinks.ts), then code.
// A daemon-fetched bundle goes through Blob URL import() (bare import() can't carry the Bearer header), which forces
// single-file ESM bundles.
// Each extension's failure is contained and recorded on a status the Extensions tab renders; the shell never crashes on
// a bad bundle or silently drops one. What each one came to is recorded in extensionStatuses (features/extensions).

// An extension whose code did not run, said to the daemon's client log: the Extensions tab shows it only to whoever
// opens it, and a view that then never draws (a skeleton forever) otherwise left no record anywhere.
const reportLoadFailure = (status: ExtensionHostStatus, listSource: string): void => {
    const fields: ReportFields = { extensionId: status.extensionId, handle: status.id, state: status.state, listSource };
    if (status.revision !== undefined) {
        fields[`revision`] = status.revision;
    }
    if (status.bundle !== undefined) {
        fields[`bundle`] = status.bundle;
    }
    reportClient(`extension.loadError`, `${status.extensionId} ${status.state}: ${status.detail ?? `no detail`}`, { level: `warn`, fields });
};

// Revision each extension loaded at, per handle (codeRevisionOf: the pinned commit, or a dev checkout's bundle
// fingerprint); divergence from the list's current one triggers the reload prompt.
// allow(module-state): the extension host's load record, retired with the activations on a switch and on a relocale (retireExtensions)
export const loadedCommits = shallowRef<ReadonlyMap<string, string>>(new Map());

// Whether the load pass finished: held beside the statuses (extensionStatuses.ts), below this host, so a page in
// features can tell "not activated yet" from "gone" without importing it. Re-exported for the host's own readers.
export { extensionsLoaded };

// When the list the last pass loaded from was read (epoch ms). A list read before it says nothing about what came
// since: the persisted cache paints one from a previous visit, and it may name what has been removed after.
// allow(module-state): the extension host's load record, retired with the activations on a switch and on a relocale (retireExtensions)
export const loadedListAt = shallowRef(0);

// Whether a load pass is under way; a list that names an extension this record lacks is then the pass catching up,
// not an install from elsewhere waiting for a reload. Counted, since a relocale can overlap a reconcile.
// allow(module-state): the extension host's load record, like the ones above
export const extensionsReconciling = shallowRef(false);
let passes = 0;

// Generation counter for the active sandbox, bumped on switch; a stale pass must not finalize anything.
let scope = 0;

// Whether the manifest declares anything to register in the shell.
// UI contributions with no code to run is a defect; none declared is just daemon-side.
const hasUi = (manifest: ExtensionManifest): boolean =>
    (manifest.contributes?.views ?? []).length > 0 ||
    (manifest.contributes?.viewers ?? []).length > 0 ||
    (manifest.contributes?.sideViews ?? []).length > 0 ||
    (manifest.contributes?.commands ?? []).length > 0;

// Loads settings first only if the manifest declares any, so compiled-ins with none skip a round-trip; then checks
// startedIn against the current scope.
// Skips activation silently if scope moved (a sandbox switch), since an overtaken pass's report is discarded anyway.
const runActivate = async (summary: ExtensionSummary, host: HostBindings, module: ExtensionModule, startedIn: number): Promise<void> => {
    if ((summary.manifest.contributes?.settings ?? []).length > 0) {
        await extensionSettingsStore(summary.id).load();
    }
    if (module.messages !== undefined) {
        // BEFORE activate(), and awaited: activate() is where an extension registers the panels and commands whose
        // titles it has just translated. Registering them first and loading the words after is how a rail label shows
        // up in English under a reader who is not.
        await registerExtensionMessages(extensionIdOf(summary.manifest), module.messages);
    }
    if (startedIn !== scope) {
        return;
    }
    const { api, context } = createExtensionApi(summary, host);
    await module.activate(api, context);
};

const fetchBundle = async (summary: ExtensionSummary): Promise<string> => {
    const path = `/extensions/${encodeURIComponent(summary.id)}/bundle`;
    const response = await sandboxRequest(path);
    if (!response.ok) {
        throw await sandboxError(response, { method: `GET`, path });
    }
    return response.text();
};

// Loads a daemon-hosted bundle via Blob URL, revoked right after import() evaluates it; a single-file bundle has no
// later relative import to resolve.
const importBundle = async (source: string): Promise<ExtensionModule> => {
    const url = URL.createObjectURL(new Blob([source], { type: `text/javascript` }));
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
            detail: t(`extension-host.loader.needsIntenticAppProvides`, { intentic: summary.manifest.engines.intentic, extensionApiVersion }),
        };
    }
    const compiled = builtinModules.get(extensionId);
    if (compiled === undefined && summary.manifest.entry === undefined) {
        // No module and nothing to fetch: fine if daemon-only; a UI manifest means image and app differ in version.
        if (!hasUi(summary.manifest)) {
            return { ...status, state: `agent-only` };
        }
        const missing: ExtensionHostStatus = { ...status, state: `missing`, detail: t(`extension-host.loader.declaresUiAppBuild`) };
        reportLoadFailure(missing, summary.source);
        return missing;
    }
    const ran = { ...status, revision: codeRevisionOf(summary), bundle: compiled === undefined ? (`daemon` as const) : (`compiled-in` as const) };
    try {
        let module: ExtensionModule | undefined = compiled;
        if (module === undefined) {
            const source = await fetchBundle(summary);
            // Before import(): a name the host does not export, any more or yet, fails the link in the browser's own
            // words, which name neither the extension nor the fix. Its engines range passed, so the range is not saying
            // what the bundle was built against.
            const unlinked = bundleLinkProblem(source);
            if (unlinked !== undefined) {
                const stale: ExtensionHostStatus = { ...ran, state: `incompatible`, detail: unlinked };
                reportLoadFailure(stale, summary.source);
                return stale;
            }
            module = await importBundle(source);
        }
        await runActivate(summary, host, module, startedIn);
        return { ...ran, state: `active` };
    } catch (error) {
        const failed: ExtensionHostStatus = { ...ran, state: `error`, detail: messageOr(error, String(error)) };
        reportLoadFailure(failed, summary.source);
        return failed;
    }
};

// Compiled-in extensions the daemon's list didn't mention (image predates this bundle, or GET /extensions failed).
// Activated anyway from this build; reported as having no switch or settings to live in the daemon. A window on a local
// folder lists none and runs only the ones that show files (environments/local.ts).
const loadUnlisted = async (listed: ReadonlySet<string>, host: HostBindings, detail: string, startedIn: number): Promise<ExtensionHostStatus[]> =>
    Promise.all(
        [...builtinModules]
            .filter(([extensionId]) => !listed.has(extensionId) && (localFace() === undefined || LOCAL_EXTENSIONS.has(extensionId)))
            .map(async ([extensionId, module]): Promise<ExtensionHostStatus> => {
                const summary: ExtensionSummary = { id: extensionId, manifest: module.manifest, commit: `builtin`, source: `builtin`, enabled: true };
                const ran = { id: extensionId, extensionId, revision: `builtin`, bundle: `compiled-in` as const };
                try {
                    await runActivate(summary, host, module, startedIn);
                    return { ...ran, state: `unlisted`, detail };
                } catch (error) {
                    const failed: ExtensionHostStatus = { ...ran, state: `error`, detail: messageOr(error, String(error)) };
                    reportLoadFailure(failed, `unlisted`);
                    return failed;
                }
            }),
    );

// Drops everything this host holds for the current sandbox synchronously, before the new one is asked anything; a later
// re-run would leave stale tiles and a superseded extension running meanwhile.
// Drops the activations and this module's load record; extensionsLoaded going false tells the rail its composition is
// provisional again. The extensions' own module state goes with the switch itself (sandboxScope.ts), never a relocale.
export const retireExtensions = (): void => {
    scope += 1;
    deactivateAllExtensions();
    extensionStatuses.value = [];
    loadedCommits.value = new Map();
    loadedListAt.value = 0;
    extensionsLoaded.value = false;
};

const loadPass = async (host: HostBindings): Promise<void> => {
    const startedIn = scope;
    // Only fetch caught rather than thrown: on failure, run what's compiled in rather than show nothing.
    let summaries: readonly ExtensionSummary[] = [];
    let listFailure: string | undefined;
    try {
        summaries = (await sandboxRpc.extensions.list()).extensions;
    } catch (error) {
        listFailure = readFailure(error);
    }
    const listedAt = Date.now();
    // Bail if the sandbox switched mid-fetch; activating this list would restore tiles the switch just cleared.
    if (startedIn !== scope) {
        return;
    }
    if (listFailure !== undefined) {
        // Only what is compiled in runs from here; an installed extension's views will not appear this load.
        reportClient(`extension.listFailed`, listFailure, { level: `warn` });
    }
    const listed = new Set(summaries.map((summary) => extensionIdOf(summary.manifest)));
    const [listedStatuses, unlistedStatuses] = await Promise.all([
        Promise.all(summaries.map((summary) => loadOne(summary, host, startedIn))),
        loadUnlisted(
            listed,
            host,
            listFailure === undefined
                ? t(`extension-host.loader.unlistedByImage`)
                : t(`extension-host.loader.listFailedActivated`, { failure: listFailure }),
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
    loadedCommits.value = new Map(summaries.map((summary) => [summary.id, codeRevisionOf(summary)]));
    loadedListAt.value = listedAt;
    extensionsLoaded.value = true;
};

// One pass over the daemon's list, flagged on extensionsReconciling for as long as it runs.
export const loadExtensions = async (host: HostBindings): Promise<void> => {
    passes += 1;
    extensionsReconciling.value = true;
    try {
        await loadPass(host);
    } finally {
        passes -= 1;
        extensionsReconciling.value = passes > 0;
    }
};
