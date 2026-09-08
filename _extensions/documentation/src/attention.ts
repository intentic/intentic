import type { ViewBadge } from "@intentic/extension-api";
import { sandboxLedger, sandboxPoll } from "@intentic/extension-api";
import { host } from "./host.js";
import { SEEN_PATH, stagingKey } from "./paths.js";
import { listStagedTails } from "./stagedTree.js";

// Counts document sets generated and not yet reviewed, not coverage or staleness, which drift constantly and would make
// the badge meaningless. Clears by reviewing, publishing or discarding, not by waiting.

// Records when a repo's staged set was last seen; never compared against content, only presence matters.
const seen = sandboxLedger(host, SEEN_PATH);

// Sandbox-scoped, since repo names repeat across workspaces; driven by the file binding under `.intentic/config/docs/`,
// not by `everyMs`, which is only a backstop.
const { state: pending, start: startDocumentationAttention } = sandboxPoll<readonly string[]>({
    host,
    everyMs: 10 * 60_000,
    initial: () => [],
    read: async (api) => {
        const acknowledged = await seen.read();
        const staged = await Promise.all(
            api.workspace.repos().map(async ({ repo }) => {
                const tails = await listStagedTails(api, repo);
                // `repo.json` marks a set worth reviewing; a just-started run (manifest, no map yet) shouldn't
                // self-badge.
                return tails.includes(`repo.json`) && acknowledged[stagingKey(repo)] === undefined ? repo : undefined;
            }),
        );
        return staged.filter((repo): repo is string => repo !== undefined);
    },
});

export { startDocumentationAttention };

export const documentationBadge = (): ViewBadge | undefined => {
    const count = pending.value.length;
    if (count === 0) {
        return undefined;
    }
    return {
        count,
        // `info`: nothing is broken or at risk, just reading waiting, the mildest claim on attention.
        tone: `info`,
        tooltip: `${count} repositor${count === 1 ? `y has` : `ies have`} newly generated documentation waiting to be reviewed`,
    };
};

// Marks a repo's staged set as reviewed. Written to the same file tree the badge derives from, so it survives a reload
// and syncs across browsers without a new setting.
export const acknowledgeStaged = async (repo: string): Promise<void> => {
    const key = stagingKey(repo);
    pending.value = pending.value.filter((entry) => entry !== repo);
    // Only the first look writes; every open would otherwise push every browser a refetch for an unchanged fact.
    if ((await seen.read())[key] === undefined) {
        await seen.mark({ [key]: new Date().toISOString() });
    }
};
