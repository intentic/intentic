import { type Capability, CapabilitySchema } from "@intentic/sandbox-contract/schemas/capabilities";
import type { Services } from "../composition.js";
import { syncEndpointCompat } from "../endpoints/endpoint-translator.js";
import { mintsEndpointProvider } from "../endpoints/local-model.js";
import { composeEnvironment } from "../environment/overlay.js";
import { reconcileListenerProcesses } from "../extensions/extension-processes.js";
import { versionedSettingsWrite } from "../seams/settings-versions.js";
import { capabilitiesDocument } from "../capabilities/capabilities-store.js";
import type { CapabilityCtx } from "../capabilities/capability.js";
import { registry } from "../capabilities/registry.js";

// INSTALLING AND REMOVING ONE CONNECTION, the sequence the capability routes run for a person's add and remove and the
// connections hub runs for one it made from a keyring entry, so the two can never disagree about what "added" means:
// applied, stored with what the install learned, the listener extensions and the endpoint list converged. Kept here
// rather than in capabilities/, which extensions/ imports: converging the listener extensions reaches back into them.

// The capability pages' own writes to the connection manifest, each committed as it lands (settings-versions.ts): left
// uncommitted, they read as the owner's edits and a land touching the same file is refused. A rename also repoints the
// personas that name the connection, so it commits that file with it. Only where the files held nothing uncommitted
// before the write: an agent's landed change to them waiting in Changes is not the page's to commit unreviewed.
export const versionManifest = <T>(
    services: Services,
    subject: string,
    write: () => Promise<T>,
    paths: readonly string[] = [capabilitiesDocument.path],
): Promise<T> => versionedSettingsWrite(services, paths, `Settings: ${subject}`, write);

// The entry as stored once its apply succeeded: what the install learned (handler.installed), re-parsed so a handler
// cannot store what the schema refuses.
const installedEntry = async (ctx: CapabilityCtx, entry: Capability): Promise<Capability> => {
    const installed = registry[entry.kind].installed;
    return installed === undefined ? entry : CapabilitySchema.parse({ ...entry, config: await installed(ctx, entry.id, entry.config) });
};

/** Applies `entry`, streaming its handler's frames, and stores it under `subject` once the apply succeeded. */
export async function* applyAndStore(services: Services, ctx: CapabilityCtx, entry: Capability, subject: string) {
    yield* registry[entry.kind].apply(ctx, entry.id, entry.config);
    const stored = await installedEntry(ctx, entry);
    await versionManifest(services, subject, () => services.capabilities.upsert(stored));
    return stored;
}

/** What follows any connection added or removed: the listener extensions, and the endpoint list a turn routes by. */
export const convergeAfterConnectionChange = async (services: Services, kind: Capability["kind"]): Promise<void> => {
    // A connector add or remove flips whether its provider's gateway is wanted; this converges listener extensions.
    void reconcileListenerProcesses(services);
    // Awaited, not fire-and-forget: "added" must mean the next turn on this endpoint actually routes.
    if (mintsEndpointProvider(kind)) {
        await syncEndpointCompat(services);
    }
};

/** Removes one connection: its handler's own teardown, the manifest entry, then what depended on it. */
export const uninstallConnection = async (services: Services, ctx: CapabilityCtx, capability: Capability, subject: string): Promise<void> => {
    const handler = registry[capability.kind];
    if (handler.remove === undefined) {
        throw new Error(`the ${capability.kind} capability can't be removed`);
    }
    await handler.remove(ctx, capability.id, capability.config);
    // The warm subprocess dies with a removed agent capability; a re-add respawns lazily on the next turn.
    if (capability.kind === "agent") {
        services.acpConnections.drop(capability.id);
    }
    await versionManifest(services, subject, () => services.capabilities.remove(capability.id));
    // Removed only after the manifest drops it, so the rebuilt list can't put the endpoint straight back.
    await convergeAfterConnectionChange(services, capability.kind);
    await composeEnvironment(services);
    // A removed extension's backend retires with it; a no-op for other kinds, whose set is unchanged.
    if (capability.kind === "extension") {
        services.extensionBackend.restart();
    }
};
