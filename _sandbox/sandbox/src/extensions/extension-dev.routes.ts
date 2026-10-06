import { extensionIdOf } from "@intentic/extension-manifest";
import { extensionsContract } from "@intentic/sandbox-contract";
import { implement, ORPCError } from "@orpc/server";
import { invalidateContributions } from "../capabilities/contributions.js";
import { extensionDir, extensionRootOf, readExtensionManifest } from "../capabilities/extension-dirs.js";
import type { Services } from "../composition.js";
import type { OrpcContext } from "../app-env.js";
import { opt } from "../opt.js";
import { pathExists } from "@intentic/base/fs";
import { checkDevCheckout, devSummaryOf, forgetExtensionDev, readExtensionDev, touchExtensionDev, writeExtensionDev } from "./extension-dev.js";
import { callerConversation, devTargetOf, resolveDevPath, sourceCheckoutOf } from "./extension-dev-source.js";
import { followExtensionDirs, reconcileListenerProcesses } from "./extension-processes.js";
import { extensionInventory, type InstalledExtension, installedExtensions } from "./installed-extensions.js";

// Dev mode's verbs (extension-dev.ts says what it is): the agent's `extension` CLI drives all four on the agent token,
// the Extensions tab's way back calls devClear. Spread into the extensions routes, whose contract they belong to.

const CONVERSATION_HEADER = "x-intentic-conversation";

export const createExtensionDevRoutes = (services: Services) => {
    const i = implement(extensionsContract).$context<OrpcContext>();
    const root = services.workspace.root;
    const roots = { root, historyRoot: services.config.historyRoot };

    // The install a verb names, from every enumerated one (a disabled one included); refused for one that already runs
    // from its source.
    const targetOf = async (id: string): Promise<InstalledExtension> => {
        const target = devTargetOf((await extensionInventory(services)).extensions, id);
        if ("refused" in target) {
            throw new ORPCError("NOT_FOUND", { message: target.refused });
        }
        return target;
    };
    // What switching an install's directory moves, the same convergence the on/off switch runs plus moving what runs onto
    // the new directory; `restart` restarts its processes in place too, for a rebuild.
    const rewire = async (id: string, restart: boolean): Promise<void> => {
        const only = new Set([id]);
        await followExtensionDirs(services, { autoStart: only, ...opt("restart", restart ? only : undefined) });
        void reconcileListenerProcesses(services);
        invalidateContributions();
        services.extensionBackend.restart();
    };
    const stateOf = async (id: string) => {
        const extension = (await installedExtensions(services)).find((entry) => entry.id === id);
        const dev = extension === undefined ? undefined : await devSummaryOf(extension);
        if (extension === undefined || dev === undefined) {
            throw new ORPCError("CONFLICT", { message: "it was removed, or let go of its checkout, while this ran" });
        }
        return { id: extension.id, name: extensionIdOf(extension.manifest), dev };
    };
    // One install has one dev checkout, so a conversation that pointed it somewhere keeps it: another conversation's
    // replace, reload or clear is refused, naming the holder, instead of silently taking over its build. A call naming no
    // conversation (the owner's Extensions tab) is never refused, and a checkout that is gone holds nothing.
    const refuseOtherHolder = async (id: string, caller: string | undefined): Promise<void> => {
        const pointer = (await readExtensionDev(root))[id];
        if (caller === undefined || pointer?.setBy === undefined || pointer.setBy === caller || !(await pathExists(pointer.path))) {
            return;
        }
        throw new ORPCError("PRECONDITION_FAILED", {
            message: `it already runs from a checkout conversation ${pointer.setBy} set (${pointer.path}); only that conversation can change it, or the owner from the Extensions tab`,
        });
    };
    // The checkout a set means: the one named, read against the caller's own copy of the workspace, or the one cloned
    // from the address it was installed from.
    const checkoutFor = async (
        extension: InstalledExtension,
        url: string,
        path: string | undefined,
        conversation: string | undefined,
        configPath: string | undefined,
    ) => {
        if (path !== undefined) {
            return resolveDevPath(roots, path, conversation, configPath);
        }
        const found = await sourceCheckoutOf(roots, url, conversation);
        if (found === undefined) {
            const name = extension.manifest.name;
            throw new ORPCError("PRECONDITION_FAILED", {
                message: `this workspace has no checkout of ${url}. Clone it into extensions/${name} (git clone ${url} extensions/${name}), then try again`,
            });
        }
        return found.absolute;
    };

    return {
        devList: i.devList.handler(async ({ context }) => {
            const conversation = callerConversation(context.headers.get(CONVERSATION_HEADER));
            const capabilities = await services.capabilities.list();
            const extensions = [];
            for (const extension of (await extensionInventory(services)).extensions) {
                const capability = capabilities.find((entry) => entry.id === extension.id);
                if (extension.source !== "installed" || capability?.kind !== "extension") {
                    continue;
                }
                const found = await sourceCheckoutOf(roots, capability.config.url, conversation);
                extensions.push({
                    id: extension.id,
                    name: extensionIdOf(extension.manifest),
                    commit: await services.git.fullHead(extensionDir(root, extension.id)),
                    ...opt("dev", await devSummaryOf(extension)),
                    ...opt("checkout", found === undefined ? undefined : { path: found.path, ...opt("conversation", found.conversation) }),
                });
            }
            return { extensions };
        }),
        // Refuses a checkout that is no stand-in at all (gone, outside the workspace, another extension); writes and holds
        // one the work in it gets out of (not built yet, different powers), so building it is all that is left to do.
        devSet: i.devSet.handler(async ({ input, context }) => {
            const extension = await targetOf(input.id);
            const capability = await services.capabilities.get(extension.id);
            if (capability?.kind !== "extension") {
                throw new ORPCError("NOT_FOUND", { message: `no installed extension is called "${input.id}"` });
            }
            const configPath = capability.config.path;
            const conversation = callerConversation(context.headers.get(CONVERSATION_HEADER));
            await refuseOtherHolder(extension.id, conversation);
            const path = await checkoutFor(extension, capability.config.url, input.path, conversation, configPath);
            const pinned = await readExtensionManifest(extensionRootOf(extensionDir(root, extension.id), configPath));
            if (pinned === undefined) {
                throw new ORPCError("PRECONDITION_FAILED", { message: "its installed copy has no readable manifest to compare a checkout against" });
            }
            const checked = await checkDevCheckout(roots, path, pinned, configPath);
            if ("held" in checked && checked.fatal) {
                throw new ORPCError("PRECONDITION_FAILED", { message: `${checked.held}, so it keeps running its pinned version` });
            }
            await writeExtensionDev(root, extension.id, {
                path: checked.checkout ?? path,
                ...opt("conversation", checked.place?.conversation),
                ...opt("setBy", conversation),
                setAt: new Date().toISOString(),
            });
            await rewire(extension.id, false);
            return stateOf(extension.id);
        }),
        devClear: i.devClear.handler(async ({ input, context }) => {
            const extension = await targetOf(input.id);
            await refuseOtherHolder(extension.id, callerConversation(context.headers.get(CONVERSATION_HEADER)));
            const cleared = await forgetExtensionDev(root, extension.id);
            if (cleared) {
                await rewire(extension.id, false);
            }
            return { id: extension.id, name: extensionIdOf(extension.manifest), cleared };
        }),
        // The rebuild already happened in the checkout; this is the poke that makes everything holding the old build let go
        // of it: running processes restart, the backend host reloads on the new bundle digest, and the touched pointer file
        // tells an open app its list changed.
        devReload: i.devReload.handler(async ({ input, context }) => {
            const extension = await targetOf(input.id);
            await refuseOtherHolder(extension.id, callerConversation(context.headers.get(CONVERSATION_HEADER)));
            if (extension.dev === undefined) {
                throw new ORPCError("PRECONDITION_FAILED", {
                    message: `${extensionIdOf(extension.manifest)} runs its pinned version, not a source checkout, so there is nothing to reload`,
                });
            }
            await touchExtensionDev(root, extension.id, new Date().toISOString());
            // Read again: a checkout held as not built yet may be built now, and only a checkout that runs has a build to
            // restart onto.
            const now = await targetOf(extension.id);
            await rewire(extension.id, now.dev !== undefined && now.dev.held === undefined);
            return stateOf(extension.id);
        }),
    };
};
