import { join } from "node:path";
import { compareEntries, REGISTRY_FACTS_FILE, REGISTRY_FILE, RegistryFactsSchema, RegistryFileSchema, resolveRegistry } from "@intentic/registry";
import type { Marketplace } from "@intentic/sandbox-contract";
import type { CapabilityCtx } from "./capability.js";
import { gitAuthHeader } from "./git-checkout.js";
import { pluginsRoot } from "./plugin-dirs.js";

/* Resolve a registry repo into installable entries — the format and the join live in @intentic/registry, so
 * the app's browse list and the site's gallery are the same rows in the same order.
 *
 * The checkout is a throwaway read under a fixed tmp name — concurrent browses on one sandbox could collide,
 * but a sandbox has one owner and the loser just retries.
 *
 * Cloning to read two JSON files is the right trade for a private registry of a dozen internal extensions,
 * which is the case this has to work for offline and behind a token. For the OFFICIAL registry at scale it is
 * a full clone per browse of a repo that only ever grows; if that starts to bite, serve the resolved list as a
 * static asset from the site and fetch it here for that one URL, keeping this path for everyone else. */
export const browseMarketplace = async (ctx: CapabilityCtx, url: string, token?: string): Promise<Marketplace> => {
    const root = pluginsRoot(ctx.workspace.root);
    const tmpName = ".marketplace.tmp";
    const tmp = join(root, tmpName);
    await ctx.files.mkdir(root);
    await ctx.files.remove(tmp);
    try {
        await ctx.git.clone(root, tmpName, url, token !== undefined ? { authHeader: gitAuthHeader(token) } : undefined);
        const raw = await ctx.files.read(join(tmp, REGISTRY_FILE));
        if (raw === undefined) {
            throw new Error(`not a plugin marketplace: no ${REGISTRY_FILE} in the repo`);
        }
        const file = RegistryFileSchema.parse(JSON.parse(raw));
        // Absent on every registry that runs no scanner — the rows then simply carry no stars.
        const rawFacts = await ctx.files.read(join(tmp, REGISTRY_FACTS_FILE));
        const facts = rawFacts === undefined ? undefined : RegistryFactsSchema.parse(JSON.parse(rawFacts));
        return { name: file.name, plugins: resolveRegistry(file, facts, url).toSorted(compareEntries) };
    } finally {
        await ctx.files.remove(tmp);
    }
};
