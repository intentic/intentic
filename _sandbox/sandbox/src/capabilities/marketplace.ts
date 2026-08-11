import { join } from "node:path";
import { compareEntries, REGISTRY_FACTS_FILE, REGISTRY_FILE, RegistryFactsSchema, RegistryFileSchema, resolveRegistry } from "@intentic/registry";
import type { Marketplace } from "@intentic/sandbox-contract";
import { gitAuthHeader } from "./git-checkout.js";
import { pluginsRoot } from "./plugin-dirs.js";

// The daemon surface a registry read needs — a structural subset of both CapabilityCtx and Services, so the
// browse route passes its handler ctx and the extension update check passes `services` directly.
export interface MarketplaceHost {
    readonly workspace: { readonly root: string };
    readonly files: {
        readonly read: (absPath: string) => Promise<string | undefined>;
        readonly mkdir: (absPath: string) => Promise<void>;
        readonly remove: (absPath: string) => Promise<void>;
    };
    readonly git: { readonly clone: (parentDir: string, name: string, cloneUrl: string, options?: { authHeader?: string }) => Promise<void> };
}

/* Resolve a registry repo into installable entries — the format and the join live in @intentic/registry, so
 * the app's browse list and the site's gallery are the same rows in the same order.
 *
 * The checkout is a throwaway read under a fixed tmp name — concurrent browses on one sandbox could collide,
 * but a sandbox has one owner and the loser just retries. The update check names its own tmp (`tmpName`) so a
 * background comparison never races a browse the owner is looking at.
 *
 * Cloning to read two JSON files is the right trade for a private registry of a dozen internal extensions,
 * which is the case this has to work for offline and behind a token. For the OFFICIAL registry at scale it is
 * a full clone per browse of a repo that only ever grows; if that starts to bite, serve the resolved list as a
 * static asset from the site and fetch it here for that one URL, keeping this path for everyone else. */
export const browseMarketplace = async (host: MarketplaceHost, url: string, token?: string, tmpName = ".marketplace.tmp"): Promise<Marketplace> => {
    const root = pluginsRoot(host.workspace.root);
    const tmp = join(root, tmpName);
    await host.files.mkdir(root);
    await host.files.remove(tmp);
    try {
        await host.git.clone(root, tmpName, url, token !== undefined ? { authHeader: gitAuthHeader(token) } : undefined);
        const raw = await host.files.read(join(tmp, REGISTRY_FILE));
        if (raw === undefined) {
            throw new Error(`not a plugin marketplace: no ${REGISTRY_FILE} in the repo`);
        }
        const file = RegistryFileSchema.parse(JSON.parse(raw));
        // Absent on every registry that runs no scanner — the rows then simply carry no stars.
        const rawFacts = await host.files.read(join(tmp, REGISTRY_FACTS_FILE));
        const facts = rawFacts === undefined ? undefined : RegistryFactsSchema.parse(JSON.parse(rawFacts));
        return { name: file.name, plugins: resolveRegistry(file, facts, url).toSorted(compareEntries) };
    } finally {
        await host.files.remove(tmp);
    }
};
