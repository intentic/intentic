import { randomBytes } from "node:crypto";
import { join } from "node:path";
import { gitAuthHeader } from "@intentic/base/git";
import { compareEntries, REGISTRY_FACTS_FILE, REGISTRY_FILE, RegistryFactsSchema, RegistryFileSchema, resolveRegistry } from "@intentic/registry";
import type { Marketplace } from "@intentic/sandbox-contract";
import { pluginsRoot } from "./plugin-dirs.js";

// The daemon surface a registry read needs: a structural subset of both CapabilityCtx and Services, so either can be
// passed directly.
export interface MarketplaceHost {
    readonly workspace: { readonly root: string };
    readonly files: {
        readonly read: (absPath: string) => Promise<string | undefined>;
        readonly mkdir: (absPath: string) => Promise<void>;
        readonly remove: (absPath: string) => Promise<void>;
    };
    readonly git: { readonly clone: (parentDir: string, name: string, cloneUrl: string, options?: { authHeader?: string }) => Promise<void> };
}

// Clones into a throwaway dir to read two JSON files. Named afresh per call, so two browses, or a browse and an update
// check, never clone over or delete each other's copy. Fine for a private registry, not for a full clone per browse of
// the ever-growing OFFICIAL one.
export const browseMarketplace = async (host: MarketplaceHost, url: string, token?: string): Promise<Marketplace> => {
    const root = pluginsRoot(host.workspace.root);
    // Dot-prefixed like a checkout's staging dir, so it can never be an id.
    const tmpName = `.marketplace-${randomBytes(6).toString("hex")}.tmp`;
    const tmp = join(root, tmpName);
    await host.files.mkdir(root);
    try {
        await host.git.clone(root, tmpName, url, token !== undefined ? { authHeader: gitAuthHeader(token) } : undefined);
        const raw = await host.files.read(join(tmp, REGISTRY_FILE));
        if (raw === undefined) {
            throw new Error(`not a plugin marketplace: no ${REGISTRY_FILE} in the repo`);
        }
        const file = RegistryFileSchema.parse(JSON.parse(raw));
        // Absent on a registry running no scanner; the rows then simply carry no stars.
        const rawFacts = await host.files.read(join(tmp, REGISTRY_FACTS_FILE));
        const facts = rawFacts === undefined ? undefined : RegistryFactsSchema.parse(JSON.parse(rawFacts));
        return { name: file.name, plugins: resolveRegistry(file, facts, url).toSorted(compareEntries) };
    } finally {
        await host.files.remove(tmp);
    }
};
