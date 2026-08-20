import { basename, join, relative } from "node:path";
import type { DeployRepoLink } from "../contract.js";

/* Which workspace repo belongs to which Komodo stack.
 *
 * A stack in Komodo is a docker compose project, and a repo that ships a compose file is one waiting to
 * happen. The two are usually named nearly the same, `intentic` in the repo against `intentic-platform` in
 * Komodo, so the daemon derives the repo's compose project name, ranks the stack names that resemble it, and
 * the OWNER picks. Never an automatic binding: only they know that `atlas` is this repo's staging stack, and a
 * guess that silently becomes a fact is worse than no guess at all.
 *
 * The matching is deliberately dumb and explainable. Anything cleverer (token overlap, edit distance) would
 * produce suggestions nobody can predict, and the cost of a wrong suggestion here is the owner scanning a list
 * they were going to scan anyway. */

// The compose files docker itself looks for, in its own precedence order.
const COMPOSE_NAMES = ["compose.yaml", "compose.yml", "docker-compose.yaml", "docker-compose.yml"];

// `name: my-project` at the top level. Deliberately not a YAML parse: this is one well-known key at column
// zero, and pulling a YAML dependency into the daemon to read it would be the larger change.
export const composeProjectName = (contents: string): string | undefined => {
    const matched = /^name:[ \t]*(?:"([^"]+)"|'([^']+)'|([^\s#]+))/m.exec(contents);
    if (matched === null) {
        return undefined;
    }
    const value = matched[1] ?? matched[2] ?? matched[3];
    return value === undefined || value === "" ? undefined : value;
};

// Compare on letters and digits only, so `intentic-web-platform`, `intentic_web_platform` and
// `IntenticWebPlatform` are one name. Docker itself normalizes project names about this far.
const normalize = (name: string): string => name.toLowerCase().replaceAll(/[^a-z0-9]/g, "");

/* Stack names that resemble a repo's project name, best first.
 *
 * Three tiers, and no fourth: an exact match, a stack whose name STARTS with the project name (the
 * `intentic` → `intentic-platform` case, which is how people actually name the two halves of one system), and
 * plain containment either way. A stack matching none of those is not a suggestion, it is still one click
 * away in the full picker, which is where a name nobody could have guessed belongs. */
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
            // Rank first, then name, so the order is stable across polls, a suggestion list that reshuffles under
            // the cursor is worse than one that is occasionally in the wrong order.
            .toSorted((a, b) => a.rank - b.rank || a.stack.localeCompare(b.stack))
            .map((entry) => entry.stack)
    );
};

// The narrow slice of the daemon this needs, the same shape the capability handlers take, so the whole module
// is testable with a fake filesystem.
export interface RepoScanDeps {
    readonly root: string;
    readonly read: (path: string) => Promise<string | undefined>;
}

/* One repo's compose evidence: the first compose file docker would pick, and the project name it declares.
 * A repo with no compose file yields nothing, it is not a candidate, and listing it would pad the view with
 * rows that can never be linked. */
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

// Every compose-carrying repo, with its link and its suggestions. `links` is the persisted owner decision;
// `stacks` is what this Komodo currently has, which is what the suggestions are drawn from.
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
            // A link to a stack that has since been deleted is dropped rather than shown as broken: the row
            // falls back to being a suggestion, which is the state the owner can act on.
            ...(linkedStack !== undefined && stacks.includes(linkedStack) ? { linkedStack } : {}),
            suggestions: rankStacks(compose.projectName, stacks),
        });
    }
    return found;
};
