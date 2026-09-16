import { relative } from "node:path";
import { contributedCardOf, extensionIdOf } from "@intentic/extension-manifest";
import type { Capability, ExtensionRemovalConnection, ExtensionRemovalPlan } from "@intentic/sandbox-contract";
import { type CapabilityCtx, capabilityCtx } from "../capabilities/capability.js";
import { contributionKey, contributionRegistry, type ResolvedContribution } from "../capabilities/contributions.js";
import { extensionDir, extensionsRoot } from "../capabilities/extension-dirs.js";
import { previousDir } from "../capabilities/git-checkout.js";
import { registry } from "../capabilities/registry.js";
import { secretFieldsOf } from "../capabilities/credentials/secret-fields.js";
import type { Services } from "../composition.js";
import { syncEndpointCompat } from "../endpoints/endpoint-translator.js";
import { mintsEndpointProvider } from "../endpoints/local-model.js";
import { composeEnvironment } from "../environment/environment.js";
import { forgetExtensionEnablement } from "./extension-enablement.js";
import { extensionProcessKey, reconcileListenerProcesses } from "./extension-processes.js";
import { forgetExtensionSettings, readAllExtensionSettings } from "./extension-settings.js";
import { forgetUpdateState, previousVersionOf } from "./extension-updates.js";
import { forgetExtensionUsage } from "./extension-usage.js";
import { ESSENTIAL_EXTENSIONS, type InstalledExtension } from "./installed-extensions.js";

// Removing an extension, and the read an owner gets before deciding to. Removal is the one act that means an
// extension's IDENTITY is going rather than its checkout: everything else in this directory deliberately keys state by
// publisher.name so it survives a re-clone, an update, even a remove-and-re-add of the capability entry. That design is
// what makes this file necessary — the same keys have to be swept here, or a re-install would silently inherit a
// stranger's switch, settings and credentials.
//
// Contributed capability cards are the other half. A card is data from the manifest; the connection the owner
// configured from it is a real entry with real credentials, and it cannot outlive the extension that supplies its form,
// its skill file and (for a cli) its environment. So those entries are torn down through their own handlers, and the
// plan names every one of them before anything happens.

// What tearing one connection down actually costs, in the kind's own terms; the plan says this per connection rather
// than once for the list, since a browser account and an enrolled machine lose very different things.
const effectOf = (capability: Capability): string => {
    switch (capability.kind) {
        case "cli":
            return "its environment variables leave the agent's shell and the skill file teaching this tool is deleted";
        case "browser":
            return capability.config.identity === undefined
                ? "its signed-in browser profile is deleted, so nothing can act as that account again without signing in"
                : "it stops being one of that identity's accounts; the shared browser profile itself stays signed in";
        case "host":
            return "that machine's key is revoked and its link to this sandbox cut; nothing on the machine itself is deleted";
        case "webext":
            return "that browser's pairing is revoked; the extension installed over there stays, disconnected";
        default:
            return "its configuration is torn down and its stored values deleted";
    }
};

// Configured entries that came from one of this extension's cards, matched on the card's own discriminator — the same
// join the capability list uses to render a contributed row, so an entry and its card can never disagree here. An
// `agent` card pins no discriminator and so matches nothing: what it produced is an ordinary agent connection that
// works without this extension, and removing one on a name match would be a guess.
const contributedCapabilities = async (services: Services, extension: InstalledExtension): Promise<Capability[]> => {
    const contributions = extension.manifest.contributes?.capabilities ?? [];
    if (contributions.length === 0) {
        return [];
    }
    return (await services.capabilities.list()).filter((capability) => contributedCardOf(contributions, capability) !== undefined);
};

// The card registry `echo` consults, forced to carry THIS extension's own cards even while it is switched off: a
// disabled extension is absent from contributionRegistry, and without its card `echo` cannot tell a credential from a
// hostname, so every field of every connection would be reported to the owner as a stored secret.
const registryIncluding = async (services: Services, extension: InstalledExtension): Promise<Map<string, ResolvedContribution>> => {
    const cards = await contributionRegistry(services);
    for (const spec of extension.manifest.contributes?.capabilities ?? []) {
        const key = contributionKey(spec.kind, spec.id);
        if (!cards.has(key)) {
            cards.set(key, { spec, extension });
        }
    }
    return cards;
};

// Why this one cannot be removed at all. Both refusals are about removal being the wrong instrument, not about
// permission, so each names the thing that IS the instrument.
const blockedReason = (extension: InstalledExtension): string | undefined => {
    if (ESSENTIAL_EXTENSIONS.has(extensionIdOf(extension.manifest))) {
        return "This is the only window onto work the sandbox does on its own, which carries on whether the page is here or not. Removing it would hide the work, not stop it.";
    }
    if (extension.source === "builtin") {
        return "This one is built into the sandbox image, so there is nothing here to delete. Its switch already stops everything it contributes; a different image is the only thing that removes it.";
    }
    return undefined;
};

// Declared processes the supervisor currently has up; a declared-but-stopped one stopping is a no-op not worth telling.
const runningProcesses = (services: Services, extension: InstalledExtension): string[] =>
    (extension.manifest.contributes?.processes ?? [])
        .map((process) => process.name)
        .filter((name) => services.serviceProcesses.statusOf(extensionProcessKey(extension.id, name))?.state === "running");

// Stored keys, not declared ones: the owner is being told what they will have to enter again, and a setting they never
// filled in is nothing to warn about. An empty secret reads as unset, the same rule the settings route uses.
const storedSettingsOf = async (services: Services, extension: InstalledExtension, identity: string): Promise<ExtensionRemovalPlan["settings"]> => {
    const declared = extension.manifest.contributes?.settings ?? [];
    const secretKeys = new Set(declared.filter((setting) => setting.secret === true).map((setting) => setting.key));
    const stored = (await readAllExtensionSettings(services.workspace.root, services.extensionSecretVault))[identity] ?? {};
    return Object.entries(stored)
        .filter(([, value]) => value !== "")
        .map(([key]) => ({ key, secret: secretKeys.has(key) }));
};

// The kept-one-back checkout is listed separately because it is a second copy on disk, and because its presence is
// exactly what "you could still revert" means — removal is what ends that.
const deletedDirsOf = async (services: Services, extension: InstalledExtension): Promise<ExtensionRemovalPlan["files"]> => {
    const root = services.workspace.root;
    if (extension.source === "workspace") {
        return [{ path: relative(root, extension.dir), detail: "its source, authored here; the deletion lands as a tracked change you can review or undo" }];
    }
    if (extension.source !== "installed") {
        return [];
    }
    const kept = await previousVersionOf(services, extension.id, undefined);
    return [
        { path: relative(root, extensionDir(root, extension.id)), detail: `the checkout at ${extension.manifest.version}, re-clonable from its source` },
        ...(kept === undefined
            ? []
            : [
                  {
                      path: relative(root, previousDir(extensionsRoot(root), extension.id)),
                      detail: `version ${kept.version ?? kept.ref.slice(0, 12)}, kept one step back; reverting stops being possible`,
                  },
              ]),
    ];
};

// Listed, never removed: these are the owner's own automations. They survive and stop firing, which is the sort of
// thing a removal is otherwise found out by weeks later, from work that quietly stopped happening.
const strandedAutomationsOf = async (services: Services, extension: InstalledExtension): Promise<string[]> => {
    const provider = extension.manifest.contributes?.listener?.provider;
    if (provider === undefined) {
        return [];
    }
    const automations = await services.automations.list();
    return automations.filter((a) => a.trigger.kind === "listener" && a.trigger.provider === provider).map((a) => a.id);
};

// The other half of an honest plan: what it does NOT touch, so the list of what goes can be read as complete rather
// than as everything the reader happened to think of.
const keepsOf = (extension: InstalledExtension, strandedAutomations: number): string[] => {
    const presets = (extension.manifest.contributes?.capabilities ?? []).filter((spec) => spec.kind === "agent");
    const templated = extension.manifest.contributes?.automationTemplates !== undefined;
    return [
        "anything it wrote in your workspace stays where it is",
        ...(strandedAutomations > 0 || templated ? ["automations you built with it stay; a template is a starting point, not a dependency"] : []),
        ...(presets.length > 0 ? ["connections added from its preset cards stay: those are ordinary connections that never needed it"] : []),
        ...(extension.source === "installed" ? ["its source repository is untouched, so installing it again is one paste of the same address"] : []),
    ];
};

export const planExtensionRemoval = async (services: Services, extension: InstalledExtension): Promise<ExtensionRemovalPlan> => {
    const identity = extensionIdOf(extension.manifest);
    const contributions = extension.manifest.contributes?.capabilities ?? [];
    const [configured, connectors, settings, files, automations] = await Promise.all([
        contributedCapabilities(services, extension),
        registryIncluding(services, extension),
        storedSettingsOf(services, extension, identity),
        deletedDirsOf(services, extension),
        strandedAutomationsOf(services, extension),
    ]);
    const connections: ExtensionRemovalConnection[] = configured.map((capability) => ({
        id: capability.id,
        kind: capability.kind,
        card: contributedCardOf(contributions, capability)?.catalog.name ?? capability.kind,
        secrets: [...secretFieldsOf(capability, connectors)],
        effect: effectOf(capability),
    }));
    const blocked = blockedReason(extension);
    return {
        id: extension.id,
        name: identity,
        version: extension.manifest.version,
        source: extension.source,
        ...(blocked === undefined ? {} : { blocked }),
        files,
        connections,
        settings,
        processes: runningProcesses(services, extension),
        automations,
        rebuildNeeded: extension.manifest.contributes?.environment !== undefined && extension.enabled,
        keeps: keepsOf(extension, automations.length),
    };
};

// Each configured connection through its own handler, while the extension's checkout is still on disk: a cli's skill
// file and a card's fragment are read from it, so tearing these down after the files went would be tearing down half.
const tearDownConnections = async (services: Services, ctx: CapabilityCtx, configured: readonly Capability[]): Promise<void> => {
    for (const capability of configured) {
        // A kind with no teardown would leave a card-less entry behind; dropping the manifest row is still right,
        // since its card is going either way.
        await registry[capability.kind].remove?.(ctx, capability.id, capability.config);
        await services.capabilities.remove(capability.id);
    }
};

// The extension itself, which means two different things: a git install is a capability entry over a checkout, a
// workspace extension is nothing but its directory.
const tearDownExtension = async (services: Services, ctx: CapabilityCtx, extension: InstalledExtension): Promise<void> => {
    if (extension.source !== "installed") {
        await services.files.remove(extension.dir);
        // The owner's files are theirs; this delete is an agent-visible write, told the same way an edit is.
        services.history.notifyUserWrite();
        return;
    }
    const entry = await services.capabilities.get(extension.id);
    if (entry?.kind === "extension") {
        await registry.extension.remove?.(ctx, entry.id, entry.config);
    }
    await services.capabilities.remove(extension.id);
};

// Order matters and is the whole risk surface: connections come down first, then the extension, then the ledgers keyed
// by its identity, then the convergence every capability change does.
export const removeExtension = async (
    services: Services,
    extension: InstalledExtension,
): Promise<{ readonly connections: readonly string[]; readonly rebuildNeeded: boolean }> => {
    const root = services.workspace.root;
    const identity = extensionIdOf(extension.manifest);
    const ctx = capabilityCtx(services);
    const configured = await contributedCapabilities(services, extension);
    await tearDownConnections(services, ctx, configured);

    // Stops every declared process, not just the running ones the plan named: a process that came up between the read
    // and the click is exactly the one that would otherwise outlive its own code.
    for (const process of extension.manifest.contributes?.processes ?? []) {
        services.serviceProcesses.stop(extensionProcessKey(extension.id, process.name));
    }
    await tearDownExtension(services, ctx, extension);

    await Promise.all([
        forgetExtensionSettings(root, services.extensionSecretVault, identity),
        forgetExtensionEnablement(root, identity),
        forgetExtensionUsage(root, identity),
        forgetUpdateState(root, identity),
    ]);

    // Same convergence as removing any capability: fragments leave the overlay, gateways stop being wanted, a removed
    // endpoint provider stops routing, and the backend host restarts on the set that no longer includes this one.
    const composedHash = await composeEnvironment(services);
    void reconcileListenerProcesses(services);
    if (configured.some((capability) => mintsEndpointProvider(capability.kind))) {
        await syncEndpointCompat(services);
    }
    services.extensionBackend.restart();

    return {
        connections: configured.map((capability) => capability.id),
        rebuildNeeded: composedHash !== undefined && composedHash !== services.config.sandbox.environmentHash,
    };
};
