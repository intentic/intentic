import { bundleProblem, type ExtensionManifest, ExtensionManifestSchema, extensionIdOf } from "@intentic/extension-manifest";
import { githubRepoOf, type RegistryChecks, type RegistryFacts, type RegistryFile, REGISTRY_TOPIC, resolveSource } from "@intentic/registry";
import type { GithubReader, GithubRepo } from "./github.js";

// Scans GitHub for a topic and proposes pull requests against the registry repo; nothing merges automatically and
// nobody logs in. `facts` overwrites nightly, `proposals` are one pull request per listing, `warnings` are for a human
// to read. Delisting stays manual: a repo back from private returns to its listing, not a deletion.

// Repo-root manifest path; a subdirectory manifest is real but undiscoverable, listed by hand instead.
const MANIFEST_PATH = "intentic-extension.json";

export interface ListingProposal {
    /** owner/repo the manifest was read from. */
    repo: string;
    /** The row to add to the curated file, verbatim. */
    entry: {
        name: string;
        kind: "extension";
        trust: "listed";
        description?: string;
        version: string;
        logo?: string;
        icon?: string;
        source: { source: "github"; repo: string; sha: string };
    };
}

export interface ScanResult {
    facts: RegistryFacts;
    proposals: ListingProposal[];
    warnings: string[];
}

// The registry's already-listed view of one repo: enough to skip re-proposing it and to re-derive its checks at the
// exact commit it's pinned to.
interface ListedEntry {
    readonly name: string;
    readonly ref: string | undefined;
    // Subdirectory within the pinned tree holding the manifest; "" means the repo's own root.
    readonly path: string;
}

const listedRepos = (file: RegistryFile): Map<string, ListedEntry> => {
    const byRepo = new Map<string, ListedEntry>();
    for (const plugin of file.plugins) {
        const install = resolveSource(plugin.source, "", file.metadata?.pluginRoot);
        const repo = githubRepoOf(install);
        if (repo !== undefined) {
            byRepo.set(repo.toLowerCase(), { name: plugin.name, ref: install?.ref, path: install?.path ?? "" });
        }
    }
    return byRepo;
};

interface CommitInspection {
    readonly checks: RegistryChecks;
    readonly manifest?: ExtensionManifest;
}

// Shared inspection for both a new proposal and an existing listing; both read the exact pinned commit, never the
// branch.
const inspectAtSha = async (fullName: string, sha: string, path: string, github: GithubReader): Promise<CommitInspection> => {
    const prefix = path === "" ? "" : `${path.replace(/\/$/u, "")}/`;
    const raw = await github.readFile(fullName, sha, `${prefix}${MANIFEST_PATH}`);
    if (raw === undefined) {
        return { checks: { sha, manifest: `no ${MANIFEST_PATH} at the pinned commit`, bundle: "unchecked" } };
    }
    let parsed;
    try {
        parsed = ExtensionManifestSchema.safeParse(JSON.parse(raw));
    } catch {
        return { checks: { sha, manifest: `${MANIFEST_PATH} is not JSON at the pinned commit`, bundle: "unchecked" } };
    }
    if (!parsed.success) {
        return {
            checks: {
                sha,
                manifest: `does not parse, ${parsed.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ")}`,
                bundle: "unchecked",
            },
        };
    }
    const engines = parsed.data.engines.intentic;
    if (parsed.data.entry === undefined) {
        return { manifest: parsed.data, checks: { sha, manifest: "ok", bundle: "none", engines } };
    }
    const source = await github.readFile(fullName, sha, `${prefix}${parsed.data.entry}`);
    if (source === undefined) {
        return {
            manifest: parsed.data,
            checks: { sha, manifest: "ok", bundle: `the manifest promises ${parsed.data.entry}, which is not at the pinned commit`, engines },
        };
    }
    return { manifest: parsed.data, checks: { sha, manifest: "ok", bundle: bundleProblem(source) ?? "ok", engines } };
};

// Turns one candidate repo into a proposal or the reason it isn't; keyed by `extensionIdOf(manifest)` (publisher.name)
// so a copied manifest collides with the existing listing instead of squatting a new one.
const propose = async (repo: GithubRepo, github: GithubReader, listed: Map<string, ListedEntry>): Promise<ListingProposal | string> => {
    if (repo.archived) {
        return `${repo.fullName}: archived`;
    }
    // Must resolve to a real commit; an uninstallable listing isn't worth proposing.
    const sha = await github.headSha(repo.fullName, repo.defaultBranch);
    if (sha === undefined) {
        return `${repo.fullName}: no commit found on ${repo.defaultBranch}`;
    }
    const { checks, manifest } = await inspectAtSha(repo.fullName, sha, "", github);
    if (manifest === undefined) {
        return `${repo.fullName}@${sha}: ${checks.manifest}`;
    }
    if (checks.bundle !== "ok" && checks.bundle !== "none") {
        return `${repo.fullName}@${sha}: the bundle ${checks.bundle}`;
    }
    const id = extensionIdOf(manifest);
    const claimedBy = [...listed.entries()].find(([, entry]) => entry.name === id);
    if (claimedBy !== undefined) {
        return `${repo.fullName}: claims ${id}, which is already listed from ${claimedBy[0]}`;
    }
    return {
        repo: repo.fullName,
        entry: {
            name: id,
            kind: "extension",
            trust: "listed",
            ...(repo.description !== undefined ? { description: repo.description } : {}),
            version: manifest.version,
            // Taken from the manifest so the two copies can't disagree; a human still reviews it in the pull request.
            ...(manifest.logo !== undefined ? { logo: manifest.logo } : {}),
            ...(manifest.icon !== undefined ? { icon: manifest.icon } : {}),
            source: { source: "github", repo: repo.fullName, sha },
        },
    };
};

// Re-derives what an installer would find at the entry's pinned commit, using the same bundle rule as the daemon's
// readiness check so the two can't drift. Not a trust verdict, only whether the pinned thing loads.
const checkAtSha = async (fullName: string, entry: ListedEntry, github: GithubReader): Promise<RegistryChecks | undefined> => {
    const sha = entry.ref ?? "";
    return (await inspectAtSha(fullName, sha, entry.path, github)).checks;
};

export const scanRegistry = async (file: RegistryFile, github: GithubReader, scannedAt: string): Promise<ScanResult> => {
    const listed = listedRepos(file);
    const warnings: string[] = [];

    const found = await github.searchByTopic(REGISTRY_TOPIC);
    const foundByRepo = new Map(found.map((repo) => [repo.fullName.toLowerCase(), repo]));

    // Every listed entry gets facts even if the topic search missed it, so a PR-only listing doesn't lose stars for
    // that.
    const entries: RegistryFacts["entries"] = [];
    for (const [repoName, entry] of listed) {
        const repo = foundByRepo.get(repoName) ?? (await github.getRepo(repoName));
        if (repo === undefined) {
            warnings.push(`${entry.name}: source repo ${repoName} is gone or no longer readable, listing may need review`);
            continue;
        }
        if (repo.archived) {
            warnings.push(`${entry.name}: source repo ${repoName} is archived`);
        }
        const checks = entry.ref === undefined ? undefined : await checkAtSha(repo.fullName, entry, github);
        // Failing checks also warn the maintainer; "none" (daemon-only) and "unchecked" aren't failures.
        if (checks !== undefined && checks.manifest !== "ok") {
            warnings.push(`${entry.name}: at the pinned commit, ${checks.manifest}`);
        } else if (checks !== undefined && checks.bundle !== "ok" && checks.bundle !== "none") {
            warnings.push(`${entry.name}: at the pinned commit, the bundle ${checks.bundle}`);
        }
        entries.push({ name: entry.name, stars: repo.stars, pushedAt: repo.pushedAt, ...(checks !== undefined ? { checks } : {}) });
    }

    // Proposes only repos the topic found that aren't already listed; sequential to dodge GitHub's secondary rate
    // limit.
    const proposals: ListingProposal[] = [];
    for (const repo of found) {
        if (listed.has(repo.fullName.toLowerCase())) {
            continue;
        }
        const outcome = await propose(repo, github, listed);
        if (typeof outcome === "string") {
            warnings.push(outcome);
            continue;
        }
        proposals.push(outcome);
    }

    // Sorted so the generated file's diff shows only the facts that changed, not a reshuffled row order.
    entries.sort((a, b) => a.name.localeCompare(b.name));
    proposals.sort((a, b) => a.entry.name.localeCompare(b.entry.name));
    return { facts: { scannedAt, entries }, proposals, warnings };
};
