import type { ExtensionModule } from "@intentic/extension-api";
import { errorMessage } from "@intentic/ui/async";
import type { ExtensionManifest } from "@intentic/extension-manifest";
import { extensionApiVersion, satisfiesEngines, resetSandboxScope } from "@intentic/extension-api";
import { extensionIdOf } from "@intentic/extension-manifest";
import { type ExtensionSummary, ExtensionsListSchema } from "@intentic/sandbox-contract";
import { shallowRef } from "vue";
import { extensionSettingsStore } from "../composables/extensions/useExtensionSettings";
import { sandboxError, sandboxJson, sandboxRequest } from "../composables/sandbox/sandboxClient";
import { createExtensionApi, deactivateAllExtensions, deactivateExtension, type HostBindings } from "./apiImpl";
import { builtinModules } from "./builtins";

/* Loads and activates the installed extensions from ONE list. GET /extensions, which enumerates the
 * compiled-in first-party ones (manifest baked into the image, code in this bundle), the daemon-side baked
 * ones and the git-installed ones alike. Per extension: the owner's switch → the engines check → its code,
 * which is either the module compiled in here or an authenticated bundle fetch → Blob URL → import(). The Blob
 * detour exists because a bare import() of a daemon URL can't carry the Bearer header, which also forces
 * single-file ESM bundles (relative chunk imports break under a blob: base).
 *
 * Every failure is contained to its own extension and recorded on a status the Sandbox hub's Extensions tab
 * renders, including the two ways the image and this bundle can disagree (`missing`, `unlisted`). The shell
 * never crashes on a bad bundle, and never silently drops an extension it couldn't run. */

export interface ExtensionHostStatus {
    // The capability entry id (the daemon's handle) and the manifest-derived identity (publisher.name).
    readonly id: string;
    readonly extensionId: string;
    /* active    , running.
     * agent-only, contributes nothing to the UI (capability cards, listeners, processes); nothing to activate.
     * disabled  , switched off by the owner. The one state the tab's toggle acts on.
     * incompatible / error, its engines don't match this app, or its activate() threw.
     * missing / unlisted  , the image and this app build disagree: a manifest with no module for it here, or
     *                        a module here the daemon doesn't know about (activated anyway, but unswitchable). */
    readonly state: "active" | "agent-only" | "disabled" | "incompatible" | "missing" | "unlisted" | "error";
    readonly detail?: string | undefined;
}

export const extensionStatuses = shallowRef<readonly ExtensionHostStatus[]>([]);

/* The commit each extension's code was loaded at IN THIS BROWSER, keyed by the daemon handle. The extensions
 * list keeps serving the checkout's CURRENT commit, so these diverging is precisely "an update landed while
 * this UI kept running the old bundle", the fact behind the tab's "reload to finish updating" prompt. Written
 * per load pass, which is why running the host again (reloadExtensions) is what clears the prompt. */
export const loadedCommits = shallowRef<ReadonlyMap<string, string>>(new Map());

// Whether a load pass has run to completion, every extension either registered what it contributes or failed
// trying. It is what tells the rail its own composition is final: until this flips, a tile that is missing may
// simply be an activate() still in flight, which is the difference between "not there" and "not there yet"
// (shell/railMemory.ts). Stays true through a later reconcile, a toggle changes the rail deliberately, and
// nothing should hold a seat open for the tile the owner just switched off.
export const extensionsLoaded = shallowRef(false);

/* WHICH SANDBOX THE LOADER IS WORKING FOR, counted rather than named, the count is all any check here needs,
 * and naming it would make this module a second place that decides what the active sandbox is.
 *
 * A load pass is several awaits long: the list, then a settings read, a bundle fetch and an activate() per
 * extension. The user can switch in the middle of any of them, and `retireExtensions` bumps this when they do.
 * Every step that would put something on screen, or declare the result final, is conditional on the count not
 * having moved since the pass began, otherwise a switch merely interleaves two sandboxes' extensions instead
 * of replacing one with the other. */
let scope = 0;

// Whether an extension has anything to register in the shell. A manifest with UI contributions and no code to
// run is a real defect; one without is simply daemon-side.
const hasUi = (manifest: ExtensionManifest): boolean =>
    (manifest.contributes?.views ?? []).length > 0 ||
    (manifest.contributes?.viewers ?? []).length > 0 ||
    (manifest.contributes?.commands ?? []).length > 0;

/* Run one extension's activate() against the manifest-gated api. Settings load FIRST so api.settings.get is
 * synchronous from the first activate() line, but only when the manifest declares any, so the nine
 * compiled-in extensions (none of which declare settings) don't cost a daemon round-trip each at every boot.
 *
 * `startedIn` is the pass's scope (see `scope` below). Registration is the last thing checked before it
 * happens, because it is the step that puts something on screen: a pass overtaken by a sandbox switch has
 * already had every earlier activation retired, and one more registering here would be a tile from the old box
 * appearing on the new box's rail seconds after the switch. Silent rather than a throw, the caller discards
 * this whole pass's report anyway, so an `error` status would be a lie nobody reads. */
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

// A daemon-hosted bundle's module. The Blob URL is revoked once import() has evaluated the module, the graph
// is materialized by then, and a single-file bundle has no later relative import to resolve against it.
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
    // The owner's switch is checked before anything else, it is the one state they can act on from the tab,
    // and an extension that is off should cost neither a bundle fetch nor an engines complaint.
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
        // Nothing to fetch and nothing compiled in. Expected for a daemon-only extension; for one that declares
        // views it means the image's manifest and this bundle were built from different commits, name the
        // drift rather than render an inert row that looks fine.
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

/* The compiled-in extensions the daemon's list didn't mention. Normally none, the image bakes a manifest for
 * every one of them. It happens when the running sandbox image predates this bundle (the dogfooding case: a
 * rebuilt app against an older daemon) or when GET /extensions failed outright, and the answer is the same
 * either way: activate them from this build so the shell still has its rail, and report that their switch and
 * settings have nowhere to live. */
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

/* EVERYTHING THIS HOST HOLDS ON BEHALF OF ONE SANDBOX, dropped in a single synchronous step, the switch's
 * first half, before the new box has been asked anything.
 *
 * Synchronous is the requirement, not a detail. Converging by simply re-running the loader would leave the
 * previous sandbox's tiles on the rail for the length of a round trip, each one still badged with its own
 * numbers, and would leave an extension the new sandbox does not have running until a load pass got around to
 * retiring it. The user reads the rail in that window; a tile that is still there is a tile they will click.
 *
 * The three things dropped are the three things that are per-sandbox: the activations (tiles, viewers,
 * documents, commands, and the timers behind every badge), the extensions' own module state (scope.ts, the
 * refs a badge is computed from, which outlive an unmounted view precisely so that they can), and this
 * module's record of what ran. `extensionsLoaded` going false is what tells the rail its composition is
 * provisional again, so railMemory holds the seats open instead of letting the column collapse and re-grow. */
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
    // The one fetch whose failure is caught rather than propagated: it decides what runs, so losing it must
    // degrade to "run what this build has" instead of leaving the shell with no extensions and no explanation.
    // The reason rides the statuses below, so the tab shows it.
    let summaries: readonly ExtensionSummary[] = [];
    let listFailure: string | undefined;
    try {
        summaries = ExtensionsListSchema.parse(await sandboxJson(`/extensions`)).extensions;
    } catch (error) {
        listFailure = errorMessage(error, String(error));
    }
    // The list came from a sandbox that is no longer the active one, activating anything off it would put that
    // box's tiles back on the rail the switch just cleared.
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
    /* Reconcile, which is what makes this re-runnable after a toggle instead of "reload to apply": anything not
     * running now gives up whatever it registered before. An extension that IS running already superseded its
     * own previous activation inside createExtensionApi, so only the non-running ones need unwinding, and
     * doing it by state here covers every way one can stop running, not just the switch. */
    for (const status of listedStatuses) {
        if (status.state !== `active`) {
            deactivateExtension(status.extensionId);
        }
    }
    /* A switch that landed while the activations above were running has already retired every one of them, and
     * this pass's report is about a sandbox nobody is looking at. Publishing it would put the old box's rows in
     * the Extensions tab and, through `extensionsLoaded`, tell the rail that a composition it has not even
     * started assembling is final. */
    if (startedIn !== scope) {
        return;
    }
    extensionStatuses.value = [...listedStatuses, ...unlistedStatuses];
    loadedCommits.value = new Map(summaries.map((summary) => [summary.id, summary.commit]));
    extensionsLoaded.value = true;
};
