import { basename, join, relative } from "node:path";
import type { DeployRepoLink } from "../contract.js";

// Which workspace repo belongs to which Komodo stack. The daemon derives the repo's compose project name, ranks stacks
// that resemble it, and the owner picks; never automatic, since a silently wrong guess is worse than none. Matching is
// deliberately dumb and explainable, not fuzzy: a wrong suggestion just costs a scan the owner was doing anyway.

// The compose files docker itself looks for, in its own precedence order.
const COMPOSE_NAMES = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"];

// Reads a top-level `name: my-project` line without a YAML parse: one well-known key at column zero, not worth a YAML
// dependency.
export const composeProjectName = (contents: string): string | undefined => {
    const matched = /^name:[ \t]*(?:"([^"]+)"|'([^']+)'|([^\s#]+))/m.exec(contents);
    if (matched === null) {
        return undefined;
    }
    const value = matched[1] ?? matched[2] ?? matched[3];
    return value === undefined || value === "" ? undefined : value;
};

// Letters and digits only, so `intentic-web-platform`, `intentic_web_platform` and `IntenticWebPlatform` compare equal,
// matching how far docker itself normalizes.
const normalize = (name: string): string => name.toLowerCase().replaceAll(/[^a-z0-9]/g, "");

// Stack names resembling the project name, best first: exact match, then a stack name starting with it, then plain
// containment either way. Anything else isn't a suggestion, just one click away in the full picker.
export const rankStacks = (projectName: string, stacks: readonly string[]): string[] => {
    const target = normalize(projectName);
    if (target === "") {
        return [];
    }
    const tier = (stack: string): number => {
        const candidate = normalize(stack);
        if (candidate === target) {
            return 0;
        }
        if (candidate.startsWith(target)) {
            return 1;
        }
        return candidate.includes(target) || target.includes(candidate) ? 2 : 3;
    };
    return (
        stacks
            .map((stack) => ({ stack, rank: tier(stack) }))
            .filter((entry) => entry.rank < 3)
            // Rank first, then name, so the list stays stable across polls instead of reshuffling under the cursor.
            .toSorted((a, b) => a.rank - b.rank || a.stack.localeCompare(b.stack))
            .map((entry) => entry.stack)
    );
};

// Narrow slice of the daemon this needs, shaped like the capability handlers' own deps, so this is testable with a fake
// filesystem.
export interface RepoScanDeps {
    readonly root: string;
    readonly read: (path: string) => Promise<string | undefined>;
}

// One repo's compose evidence: the first compose file docker would pick, and its declared project name. No compose file
// yields nothing, since an unlinkable row would just pad the view.
const repoComposeName = async (deps: RepoScanDeps, repoDir: string): Promise<{ projectName: string; composePath: string } | undefined> => {
    for (const name of COMPOSE_NAMES) {
        const path = join(repoDir, name);
        const contents = await deps.read(path);
        if (contents === undefined) {
            continue;
        }
        return {
            // No `name:` key means docker falls back to the directory name, so we do the same.
            projectName: composeProjectName(contents) ?? basename(repoDir),
            composePath: relative(deps.root, path) || name,
        };
    }
    return undefined;
};

// Every compose-carrying repo, with its link and suggestions. `links` is the persisted owner decision; `stacks` is what
// suggestions are drawn from.
export const repoLinks = async (
    deps: RepoScanDeps,
    repoDirs: readonly string[],
    stacks: readonly string[],
    links: Readonly<Record<string, string>>,
): Promise<DeployRepoLink[]> => {
    const found: DeployRepoLink[] = [];
    for (const dir of repoDirs) {
        const compose = await repoComposeName(deps, dir);
        if (compose === undefined) {
            continue;
        }
        const repo = relative(deps.root, dir) || basename(dir);
        const linkedStack = links[repo];
        found.push({
            repo,
            projectName: compose.projectName,
            composePath: compose.composePath,
            // A link to a since-deleted stack is dropped, not shown broken; the row falls back to a suggestion.
            ...(linkedStack !== undefined && stacks.includes(linkedStack) ? { linkedStack } : {}),
            suggestions: rankStacks(compose.projectName, stacks),
        });
    }
    return found;
};
