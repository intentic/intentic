import { join } from "node:path";
import { extensionIdOf } from "@intentic/extension-manifest";
import type { LandingExtensions } from "@intentic/sandbox-contract/schemas/agents";
import { parseExtensionManifest } from "../../../capabilities/extension-dirs.js";
import { extensionApprovals } from "../../../capabilities/extension-inventory/extension-approvals.js";
import type { Services } from "../../../composition.js";
import { stateRelPath } from "../../../state-paths.js";
import type { IsolatedAgent } from "../../registry/agents-store.js";

// The review's `extensions`: what landing this work turns on (extensions/landed-extensions.ts), said before the press.
// Read from the conversation's own copy of each workspace-extension folder its rows touch, and judged against the
// approvals as they stand now, so one approved meanwhile, or one whose manifest does not parse, is not listed.

const WORKSPACE_EXTENSIONS = `${stateRelPath(".intentic/config/workspace-extensions/")}/`;

export const landingExtensionsOf = async (
    deps: Pick<Services, "agentWorktrees"> & { readonly config: Pick<Services["config"], "historyRoot"> },
    entry: IsolatedAgent,
    // The review's rows, of which only each repository's changed paths are read.
    repos: readonly { readonly repo: string; readonly changes: readonly { readonly path: string }[] }[],
): Promise<LandingExtensions> => {
    const rows = repos.find(({ repo }) => repo === "root")?.changes ?? [];
    const folders = new Set(rows.flatMap(({ path }) => (path.startsWith(WORKSPACE_EXTENSIONS) ? [path.slice(WORKSPACE_EXTENSIONS.length).split("/")[0] ?? ""] : [])));
    folders.delete("");
    if (folders.size === 0) {
        return [];
    }
    const approvalOf = await extensionApprovals(deps.config.historyRoot);
    const copy = deps.agentWorktrees.worktreeDir(entry.id, "root");
    const turnsOn: LandingExtensions = [];
    for (const dir of [...folders].toSorted()) {
        const parsed = await parseExtensionManifest(join(copy, WORKSPACE_EXTENSIONS, dir));
        if (!("manifest" in parsed)) {
            continue;
        }
        const id = extensionIdOf(parsed.manifest);
        const approval = approvalOf(id, parsed.manifest);
        if (!approval.approved) {
            turnsOn.push({ id, dir, powers: approval.powers.added, approvedBefore: approval.approvedBefore });
        }
    }
    return turnsOn;
};
