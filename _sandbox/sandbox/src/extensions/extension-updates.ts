import { join } from "node:path";
import { errorMessage } from "@intentic/base/errors";
import { extensionApiVersion, satisfiesEngines } from "@intentic/extension-api/protocol";
import { diffPowers, extensionIdOf, type PowersDiff } from "@intentic/extension-manifest";
import { isShaPinned, OFFICIAL_REGISTRY_URL, type RegistryEntry } from "@intentic/registry";
import {
    type AgentTurn,
    type ExtensionAdvisory,
    ExtensionAdvisorySchema,
    type ExtensionConfig,
    type ExtensionHealth,
    ExtensionHealthSchema,
    type ExtensionUpdate,
    type ExtensionUpdatePolicy,
    ExtensionUpdateSchema,
} from "@intentic/sandbox-contract";
import { updateBrief } from "@intentic/sandbox-contract/chores";
import { z } from "zod";
import { streamAgent } from "../agent/routes/agent.routes.js";
import { capabilityCtx } from "../capabilities/capability.js";
import { extensionDir, extensionRootOf, extensionsRoot, parseExtensionManifest, readExtensionManifest } from "../capabilities/extension-dirs.js";
import { gitAuthHeader, previousDir } from "../capabilities/git-checkout.js";
import { browseMarketplace } from "../capabilities/marketplace.js";
import { registry } from "../capabilities/registry.js";
import type { Services } from "../composition.js";
import { composeEnvironment } from "../environment/environment.js";
import { capabilityFragments } from "../environment/fragment-sources.js";
import { type JsonFile, jsonFile } from "../store/json-file.js";
import { statePath } from "../workspace/layout/state-paths.js";
import { readExtensionEnablement, writeExtensionEnablement } from "./extension-enablement.js";
import { extensionProcessKey, processesDesired, reconcileListenerProcesses, startAutoStartProcesses } from "./extension-processes.js";
import { extensionRuntimeAbsent } from "./extension-readiness.js";
import { installedExtensions } from "./installed-extensions.js";

// Update lifecycle for git-installed extensions; five verbs share one fact base:
// - check: compares the installed sha against the registry; a differing row is an update, a blocked row is an advisory.
// - preview: stages the offered sha in a throwaway clone and reports the version and powers diff.
// - apply: re-clone, validate, quiesce, swap (keeping the old checkout one back), restart, health-watch.
// - revert: swaps the kept-previous checkout back; symmetric, so reverting a revert is redo.
// - watch: probes for a minute after a swap that the new version actually came up.
// Nothing auto-updates by default; an advisory's only automatic action is disabling, which reverses with a click.

// State: .intentic/records/extension-updates.json, keyed by the manifest identity, so records survive a remove/re-add.

const RecordSchema = z.object({
    update: ExtensionUpdateSchema.optional(),
    advisory: ExtensionAdvisorySchema.optional(),
    health: ExtensionHealthSchema.optional(),
});
type UpdateRecord = z.infer<typeof RecordSchema>;
const StateSchema = z.object({ checkedAt: z.string().optional(), extensions: z.record(z.string(), RecordSchema) });
type UpdateState = z.infer<typeof StateSchema>;

// Memoized per root: the write queue lives on the file object, so a fresh instance would drop concurrent writes.
const stateFiles = new Map<string, JsonFile<UpdateState>>();
const stateFile = (root: string): JsonFile<UpdateState> => {
    const path = statePath(root, ".intentic/records/extension-updates.json");
    const existing = stateFiles.get(path);
    if (existing !== undefined) {
        return existing;
    }
    const file = jsonFile<UpdateState>(path, { parse: (raw) => StateSchema.safeParse(raw).data, fallback: () => ({ extensions: {} }) });
    stateFiles.set(path, file);
    return file;
};

export const readExtensionUpdateState = async (root: string): Promise<UpdateState> => stateFile(root).read();

const patchRecord = async (root: string, identity: string, patch: (record: UpdateRecord) => UpdateRecord | undefined): Promise<void> => {
    await stateFile(root).update((state) => {
        const next = { ...state.extensions };
        const patched = patch(next[identity] ?? {});
        if (patched === undefined || Object.keys(patched).length === 0) {
            delete next[identity];
        } else {
            next[identity] = patched;
        }
        return { ...state, extensions: next };
    });
};

// Policy: .intentic/config/extension-update-policy.json; absent defaults to notify updates, auto-disable advisories.

const PolicyFileSchema = z.record(
    z.string(),
    z.object({
        updates: z.enum(["notify", "agent", "auto"]).optional(),
        advisories: z.enum(["auto-disable", "notify"]).optional(),
    }),
);
type PolicyFile = z.infer<typeof PolicyFileSchema>;

const policyFiles = new Map<string, JsonFile<PolicyFile>>();
const policyFile = (root: string): JsonFile<PolicyFile> => {
    const path = statePath(root, ".intentic/config/extension-update-policy.json");
    const existing = policyFiles.get(path);
    if (existing !== undefined) {
        return existing;
    }
    const file = jsonFile<PolicyFile>(path, { parse: (raw) => PolicyFileSchema.safeParse(raw).data, fallback: () => ({}) });
    policyFiles.set(path, file);
    return file;
};

export const resolveUpdatePolicy = (stored: PolicyFile[string] | undefined): ExtensionUpdatePolicy => ({
    updates: stored?.updates ?? "notify",
    advisories: stored?.advisories ?? "auto-disable",
});

export const readUpdatePolicies = async (root: string): Promise<PolicyFile> => policyFile(root).read();

export const writeUpdatePolicy = async (
    root: string,
    identity: string,
    patch: { updates?: ExtensionUpdatePolicy["updates"]; advisories?: ExtensionUpdatePolicy["advisories"] },
): Promise<void> => {
    await policyFile(root).update((all) => ({ ...all, [identity]: { ...all[identity], ...patch } }));
};

// Installed side of the comparison: every extension-kind capability whose checkout still parses.

interface InstalledTarget {
    readonly id: string;
    readonly config: ExtensionConfig;
    readonly identity: string;
    readonly version: string;
}

const installedTargets = async (services: Services): Promise<InstalledTarget[]> => {
    const targets: InstalledTarget[] = [];
    for (const capability of await services.capabilities.list()) {
        if (capability.kind !== "extension") {
            continue;
        }
        const config = capability.config;
        const manifest = await readExtensionManifest(extensionRootOf(extensionDir(services.workspace.root, capability.id), config.path));
        // A rotted checkout has no identity to compare under; the capability row already reports that state.
        if (manifest !== undefined) {
            targets.push({ id: capability.id, config, identity: extensionIdOf(manifest), version: manifest.version });
        }
    }
    return targets;
};

// The kept one-back checkout's identity, for the list row's "Revert to previous version" affordance.
export const previousVersionOf = async (
    services: Services,
    id: string,
    path: string | undefined,
): Promise<{ ref: string; version?: string } | undefined> => {
    const dir = previousDir(extensionsRoot(services.workspace.root), id);
    const manifest = await readExtensionManifest(extensionRootOf(dir, path));
    if (manifest === undefined) {
        return undefined;
    }
    try {
        return { ref: await services.git.fullHead(dir), version: manifest.version };
    } catch {
        return undefined;
    }
};

// Preview: what a click would approve, answered from a throwaway clone of the offered sha.

export interface UpdatePreview {
    readonly ref: string;
    readonly version: string;
    readonly installedVersion: string;
    readonly engines: string;
    readonly compatible: boolean;
    readonly powers: PowersDiff;
}

// Resolves which sha/pointer an update verb targets: an explicit ref wins, else the recorded update.
// Uses the recorded url/path only when they match that ref; otherwise falls back to the install's own pointer.
const resolveTarget = (
    config: ExtensionConfig,
    recorded: ExtensionUpdate | undefined,
    refOverride: string | undefined,
): { ref: string; url: string; path: string | undefined } => {
    const ref = refOverride ?? recorded?.ref;
    if (ref === undefined) {
        throw new Error("no update is recorded for this extension: pass the commit sha to update to");
    }
    const fromRecord = recorded !== undefined && recorded.ref === ref;
    return { ref, url: fromRecord ? recorded.url : config.url, path: fromRecord ? (recorded.path ?? undefined) : config.path };
};

export const previewExtensionUpdate = async (services: Services, id: string, refOverride?: string): Promise<UpdatePreview> => {
    const capability = await services.capabilities.get(id);
    if (capability?.kind !== "extension") {
        throw new Error("no installed extension with that id");
    }
    const config = capability.config;
    const root = services.workspace.root;
    const installed = await readExtensionManifest(extensionRootOf(extensionDir(root, id), config.path));
    const identity = installed === undefined ? undefined : extensionIdOf(installed);
    const recorded = identity === undefined ? undefined : (await readExtensionUpdateState(root)).extensions[identity]?.update;
    const target = resolveTarget(config, recorded, refOverride);
    // Same throwaway-clone trade the registry browse makes: cloned, read, removed either way.
    const parent = extensionsRoot(root);
    const tmpName = `.${id}.preview`;
    const tmp = join(parent, tmpName);
    await services.files.mkdir(parent);
    await services.files.remove(tmp);
    try {
        await services.git.clone(parent, tmpName, target.url, config.token !== undefined ? { authHeader: gitAuthHeader(config.token) } : undefined);
        await services.git.checkout(tmp, target.ref);
        const parsed = await parseExtensionManifest(extensionRootOf(tmp, target.path));
        if ("error" in parsed) {
            throw new Error(`the offered commit is not an installable extension: ${parsed.error}`);
        }
        return {
            ref: target.ref,
            version: parsed.manifest.version,
            installedVersion: installed?.version ?? "unknown",
            engines: parsed.manifest.engines.intentic,
            compatible: satisfiesEngines(parsed.manifest.engines.intentic, extensionApiVersion),
            powers: diffPowers(installed, parsed.manifest),
        };
    } finally {
        await services.files.remove(tmp);
    }
};

// Apply: the transaction, one at a time per id; a second click while one runs waits rather than interleaving clones.

const applying = new Set<string>();

export const applyExtensionUpdate = async (
    services: Services,
    id: string,
    refOverride?: string,
    options?: { readonly autoRevert?: boolean },
): Promise<{ ref: string; rebuildNeeded: boolean }> => {
    const capability = await services.capabilities.get(id);
    if (capability?.kind !== "extension") {
        throw new Error("no installed extension with that id");
    }
    if (applying.has(id)) {
        throw new Error(`"${id}" is already updating: wait for it to finish`);
    }
    applying.add(id);
    try {
        const root = services.workspace.root;
        const config = capability.config;
        const fromRef = config.ref;
        const installed = await readExtensionManifest(extensionRootOf(extensionDir(root, id), config.path));
        const identity = installed === undefined ? undefined : extensionIdOf(installed);
        const recorded = identity === undefined ? undefined : (await readExtensionUpdateState(root)).extensions[identity]?.update;
        const target = resolveTarget(config, recorded, refOverride);
        const nextConfig: ExtensionConfig = {
            ...config,
            url: target.url,
            ref: target.ref,
            ...(target.path !== undefined ? { path: target.path } : {}),
        };
        if (target.path === undefined) {
            delete nextConfig.path;
        }
        // The handler owns stage → validate → quiesce → swap; a throw leaves the old version live, running.
        const ctx = capabilityCtx(services);
        for await (const line of registry.extension.apply(ctx, id, nextConfig)) {
            void line;
        }
        await services.capabilities.upsert({ id, kind: "extension", config: nextConfig });
        // Post-apply seam, as the add route runs it: processes restart, the backend reloads, gateways converge.
        const now = (await installedExtensions(services)).find((extension) => extension.id === id);
        if (now !== undefined && now.enabled) {
            await startAutoStartProcesses(services, now);
        }
        services.extensionBackend.restart();
        void reconcileListenerProcesses(services);
        const composedHash = await composeEnvironment(services);
        const rebuildNeeded =
            (await capabilityFragments(services, { id, kind: "extension", config: nextConfig })).length > 0 &&
            composedHash !== undefined &&
            composedHash !== services.config.sandbox.environmentHash;
        if (identity !== undefined) {
            // The recorded update is spent the moment the pinned sha matches it; the health watch takes over.
            await patchRecord(root, identity, (record) => {
                const { update, ...rest } = record;
                return update !== undefined && update.ref !== target.ref ? record : rest;
            });
            await watchExtensionHealth(services, id, identity, fromRef, options?.autoRevert === true);
        }
        return { ref: target.ref, rebuildNeeded };
    } finally {
        applying.delete(id);
    }
};

// Revert: swaps the kept-previous checkout back; symmetric, so reverting a revert is redo and nothing is ever deleted.

export const revertExtensionUpdate = async (services: Services, id: string): Promise<{ ref: string }> => {
    const capability = await services.capabilities.get(id);
    if (capability?.kind !== "extension") {
        throw new Error("no installed extension with that id");
    }
    if (applying.has(id)) {
        throw new Error(`"${id}" is mid-update: wait for it to finish`);
    }
    applying.add(id);
    try {
        const root = services.workspace.root;
        const config = capability.config;
        const parent = extensionsRoot(root);
        const previous = previousDir(parent, id);
        const previousManifest = await readExtensionManifest(extensionRootOf(previous, config.path));
        if (previousManifest === undefined) {
            throw new Error("there is no previous version to revert to");
        }
        const previousRef = await services.git.fullHead(previous);
        // Quiesce the running version's declared processes before its directory moves out from under them.
        const live = extensionDir(root, id);
        const current = await readExtensionManifest(extensionRootOf(live, config.path));
        for (const process of current?.contributes?.processes ?? []) {
            services.serviceProcesses.stop(extensionProcessKey(id, process.name));
        }
        const parking = join(parent, `.${id}.reverting`);
        await services.files.remove(parking);
        await services.files.move(live, parking);
        try {
            await services.files.move(previous, live);
        } catch (error) {
            // Put the displaced version back before failing: a revert must never end with no live checkout.
            await services.files.move(parking, live);
            throw error;
        }
        await services.files.move(parking, previous);
        await services.capabilities.upsert({ id, kind: "extension", config: { ...config, ref: previousRef } });
        const now = (await installedExtensions(services)).find((extension) => extension.id === id);
        if (now !== undefined && now.enabled) {
            await startAutoStartProcesses(services, now);
        }
        services.extensionBackend.restart();
        void reconcileListenerProcesses(services);
        // Clears the health record; the next check re-lists the sha as an ordinary update instead of an alarm.
        await patchRecord(root, extensionIdOf(previousManifest), ({ health: _health, ...rest }) => rest);
        return { ref: previousRef };
    } finally {
        applying.delete(id);
    }
};

// Health: for a minute after a swap, checks that what the new version declared actually came up.
// Two probes (early, then final) give a slow boot a fair chance; autoRevert is the auto rung's failure path.

const EARLY_PROBE_MS = 15_000;
const FINAL_PROBE_MS = 60_000;

const healthProblem = async (services: Services, id: string): Promise<string | undefined | "stop"> => {
    const extension = (await installedExtensions(services)).find((candidate) => candidate.id === id);
    // Removed or switched off mid-watch: the owner intervened, and the watch has nothing left to judge.
    if (extension === undefined || !extension.enabled) {
        return "stop";
    }
    if (!(await extensionRuntimeAbsent(extension)) && (await processesDesired(services, extension))) {
        for (const process of extension.manifest.contributes?.processes ?? []) {
            if (process.autoStart === true && !services.serviceProcesses.running(extensionProcessKey(id, process.name))) {
                return `its declared process "${process.name}" is not running`;
            }
        }
    }
    if (extension.manifest.server !== undefined) {
        const backend = services.extensionBackend.statusOf(id);
        if (backend?.state === "error") {
            return `its backend failed to activate${backend.detail !== undefined ? `: ${backend.detail}` : ""}`;
        }
    }
    return undefined;
};

// Resolves once the watch is ARMED (the "watching" record is on disk); the probes themselves stay on timers.
const watchExtensionHealth = (services: Services, id: string, identity: string, fromRef: string, autoRevert: boolean): Promise<void> => {
    const root = services.workspace.root;
    const record = (health: ExtensionHealth | undefined): Promise<void> =>
        patchRecord(root, identity, ({ health: previous, ...rest }) => {
            void previous;
            return health === undefined ? rest : { ...rest, health };
        });
    const armed = record({ state: "watching", fromRef, at: new Date().toISOString() }).catch(() => undefined);
    const probe = async (final: boolean): Promise<void> => {
        const problem = await healthProblem(services, id);
        if (problem === "stop") {
            await record(undefined);
            return;
        }
        if (problem !== undefined) {
            if (autoRevert) {
                // A failed watch auto-reverts and records that; a failed revert just leaves the unhealthy verdict.
                try {
                    await revertExtensionUpdate(services, id);
                    await record({ state: "unhealthy", detail: problem, fromRef, at: new Date().toISOString(), autoReverted: true });
                    return;
                } catch (error) {
                    services.logger.warn({ err: error, extension: id }, "extension update: auto-revert failed");
                }
            }
            await record({ state: "unhealthy", detail: problem, fromRef, at: new Date().toISOString() });
            return;
        }
        if (final) {
            await record({ state: "healthy", fromRef, at: new Date().toISOString() });
        } else {
            const timer = setTimeout(() => void probe(true).catch(() => undefined), FINAL_PROBE_MS - EARLY_PROBE_MS);
            timer.unref?.();
        }
    };
    const timer = setTimeout(() => void probe(false).catch(() => undefined), EARLY_PROBE_MS);
    timer.unref?.();
    return armed;
};

// Agent-prepared rung: runs the update card's diff-read unprompted the moment the check records a new sha.
// An ordinary unattended fleet entry in a shared workspace; the update record links to it.

let reviewSeq = 0;
const reviewConversationId = (identity: string): string =>
    `ext-update-${identity.replaceAll(/[^a-zA-Z0-9_-]/gu, "-")}-${Date.now().toString(36)}${(reviewSeq++).toString(36)}`.slice(0, 64);

const prepareAgentReview = (services: Services, target: InstalledTarget, update: ExtensionUpdate): void => {
    const conversationId = reviewConversationId(target.identity);
    const prompt = updateBrief({
        label: target.identity,
        url: update.url,
        fromRef: target.config.ref,
        toRef: update.ref,
        path: update.path ?? target.config.path ?? "",
    });
    const turn: AgentTurn = {
        prompt,
        conversationId,
        unattended: true,
        // Model list this read bills to (model-roles.ts); reviewing another author's diff isn't fixing a pipeline.
        runRole: `extension-review`,
        isolated: true,
        title: `Update review: ${target.identity} ${target.version} → ${update.version ?? update.ref.slice(0, 7)}`.slice(0, 80),
    };
    void (async () => {
        await patchRecord(services.workspace.root, target.identity, (record) =>
            record.update?.ref === update.ref
                ? { ...record, update: { ...record.update, review: { conversationId, at: new Date().toISOString() } } }
                : record,
        );
        for await (const event of streamAgent(services, turn, undefined)) {
            void event;
        }
    })().catch((error: unknown) => services.logger.warn({ err: error, extension: target.identity }, "extension update: agent review failed"));
};

// Auto rung's gates, cheapest first: an unverified listing is refused before any clone; the rest come from the preview.

const autoUpdate = async (services: Services, target: InstalledTarget, update: ExtensionUpdate): Promise<void> => {
    let needsReview: string | undefined;
    try {
        if (update.trust !== "verified") {
            needsReview = "the listing isn't verified: no human has read this code";
        } else {
            const preview = await previewExtensionUpdate(services, target.id, update.ref);
            if (!preview.compatible) {
                needsReview = `it asks for app ${preview.engines}; this app is ${extensionApiVersion}`;
            } else if (preview.powers.added.length > 0) {
                needsReview = `it asks for powers the installed version didn't: ${preview.powers.added.join("; ")}`;
            } else {
                await applyExtensionUpdate(services, target.id, update.ref, { autoRevert: true });
                return;
            }
        }
    } catch (error) {
        needsReview = `auto-update failed: ${errorMessage(error)}`;
    }
    const reason = needsReview;
    await patchRecord(services.workspace.root, target.identity, (record) =>
        record.update?.ref === update.ref ? { ...record, update: { ...record.update, needsReview: reason } } : record,
    );
};

// STALE_MS bounds a page-view refresh; CHECK_INTERVAL_MS is the ceiling for a sandbox nobody opens.
const STALE_MS = 6 * 60 * 60 * 1000;
const CHECK_INTERVAL_MS = 24 * 60 * 60 * 1000;

const inFlight = new Map<string, Promise<string>>();

// One pass: reads every registry an installed extension resolves to (one clone per registry, not per extension).
// Folds each row into an update/advisory record. Unreachable keeps previous records; delisted clears them.
export const checkExtensionUpdates = (services: Services): Promise<string> => {
    const root = services.workspace.root;
    const running = inFlight.get(root);
    if (running !== undefined) {
        return running;
    }
    const run = (async (): Promise<string> => {
        const targets = await installedTargets(services);
        const byRegistry = new Map<string, InstalledTarget[]>();
        for (const target of targets) {
            const url = target.config.registry ?? OFFICIAL_REGISTRY_URL;
            byRegistry.set(url, [...(byRegistry.get(url) ?? []), target]);
        }
        const now = new Date().toISOString();
        const rows = new Map<string, RegistryEntry | undefined>();
        const unreachable = new Set<string>();
        for (const [registryUrl, group] of byRegistry) {
            try {
                const market = await browseMarketplace(services, registryUrl, undefined, ".update-check.tmp");
                for (const target of group) {
                    rows.set(
                        target.identity,
                        market.plugins.find((entry) => entry.kind === "extension" && entry.name === target.identity),
                    );
                }
            } catch (error) {
                services.logger.warn({ err: error, registry: registryUrl }, "extension update check: registry unreachable");
                for (const target of group) {
                    unreachable.add(target.identity);
                }
            }
        }
        const policies = await readUpdatePolicies(root);
        const enablement = await readExtensionEnablement(root);
        const advisoriesToEnforce: InstalledTarget[] = [];
        const updatesToAct: { target: InstalledTarget; update: ExtensionUpdate; policy: ExtensionUpdatePolicy["updates"] }[] = [];
        await stateFile(root).update((state) => {
            const next: UpdateState["extensions"] = {};
            for (const target of targets) {
                const previous = state.extensions[target.identity] ?? {};
                if (unreachable.has(target.identity)) {
                    next[target.identity] = previous;
                    continue;
                }
                const row = rows.get(target.identity);
                const record: UpdateRecord = previous.health !== undefined ? { health: previous.health } : {};
                const registryUrl = target.config.registry ?? OFFICIAL_REGISTRY_URL;
                if (row?.trust === "blocked") {
                    const reason = row.trustReason ?? "blocked by its registry, which recorded no reason";
                    const advisory: ExtensionAdvisory = {
                        reason,
                        registry: registryUrl,
                        at: previous.advisory?.reason === reason ? previous.advisory.at : now,
                        autoDisabled: previous.advisory?.autoDisabled === true,
                    };
                    record.advisory = advisory;
                    if (resolveUpdatePolicy(policies[target.identity]).advisories === "auto-disable" && enablement[target.identity] !== false) {
                        advisoriesToEnforce.push(target);
                    }
                } else if (
                    row?.admitted === true &&
                    isShaPinned(row.install) &&
                    row.install?.ref !== undefined &&
                    row.install.ref !== target.config.ref
                ) {
                    const known = previous.update?.ref === row.install.ref ? previous.update : undefined;
                    const update: ExtensionUpdate = {
                        ref: row.install.ref,
                        ...(row.version !== undefined ? { version: row.version } : {}),
                        url: row.install.url,
                        ...(row.install.path !== undefined ? { path: row.install.path } : {}),
                        trust: row.trust === "verified" ? "verified" : "listed",
                        ...(row.securityFix === true ? { securityFix: true } : {}),
                        registry: registryUrl,
                        at: known?.at ?? now,
                        ...(known?.needsReview !== undefined ? { needsReview: known.needsReview } : {}),
                        ...(known?.review !== undefined ? { review: known.review } : {}),
                    };
                    record.update = update;
                    if (known === undefined) {
                        updatesToAct.push({ target, update, policy: resolveUpdatePolicy(policies[target.identity]).updates });
                    }
                }
                if (Object.keys(record).length > 0) {
                    next[target.identity] = record;
                }
            }
            return { checkedAt: now, extensions: next };
        });
        // Runs after the state write; a crash between the two leaves a re-derivable record (mirrors setEnabled(false)).
        for (const target of advisoriesToEnforce) {
            await writeExtensionEnablement(root, target.identity, false);
            const manifest = await readExtensionManifest(extensionRootOf(extensionDir(root, target.id), target.config.path));
            for (const process of manifest?.contributes?.processes ?? []) {
                services.serviceProcesses.stop(extensionProcessKey(target.id, process.name));
            }
            await patchRecord(root, target.identity, (record) =>
                record.advisory === undefined ? record : { ...record, advisory: { ...record.advisory, autoDisabled: true } },
            );
            services.logger.warn({ extension: target.identity }, "extension advisory: blocked by its registry, disabled");
        }
        if (advisoriesToEnforce.length > 0) {
            void reconcileListenerProcesses(services);
            services.extensionBackend.restart();
        }
        for (const { target, update, policy } of updatesToAct) {
            if (policy === "auto") {
                await autoUpdate(services, target, update);
            } else if (policy === "agent") {
                prepareAgentReview(services, target, update);
            }
        }
        return now;
    })();
    inFlight.set(
        root,
        run.finally(() => inFlight.delete(root)),
    );
    return inFlight.get(root) ?? run;
};

// Called on every list read: a fresh state answers instantly; a stale one refreshes in the background, no waiting.
export const refreshUpdatesIfStale = (services: Services): void => {
    void (async () => {
        const state = await readExtensionUpdateState(services.workspace.root);
        const checkedAt = state.checkedAt === undefined ? undefined : Date.parse(state.checkedAt);
        if (checkedAt === undefined || Number.isNaN(checkedAt) || Date.now() - checkedAt > STALE_MS) {
            await checkExtensionUpdates(services);
        }
    })().catch((error: unknown) => services.logger.warn({ err: error }, "extension update check failed"));
};

// Boot wiring (main.ts): one check shortly after boot, delayed to avoid the boot path's own git work, then daily.
// The list-read staleness refresh above is the floor for a sandbox somebody is actually looking at.
export const startExtensionUpdateWatch = (services: Services): { stop: () => void } => {
    const initial = setTimeout(() => refreshUpdatesIfStale(services), 60_000);
    initial.unref?.();
    const timer = setInterval(
        () => void checkExtensionUpdates(services).catch((error: unknown) => services.logger.warn({ err: error }, "extension update check failed")),
        CHECK_INTERVAL_MS,
    );
    timer.unref?.();
    return {
        stop: () => {
            clearTimeout(initial);
            clearInterval(timer);
        },
    };
};
