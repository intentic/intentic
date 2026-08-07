import { ExtensionManifestSchema, extensionIdOf } from "@intentic/extension-manifest";
import { githubRepoOf, type RegistryFacts, type RegistryFile, REGISTRY_TOPIC, resolveSource } from "@intentic/registry";
import type { GithubReader, GithubRepo } from "./github.js";

/* THE SCAN: discovery on one side, a decision on the other, and a pull request in between.
 *
 * Two ideas were on the table for opening the registry up — scan GitHub for a topic and list what it finds,
 * or take submissions through a form on the site. Neither survives alone. A topic is a namespace anybody can
 * join, so a live scan publishes the first malicious repo to push one; a form is a login, a moderation queue
 * and an admin panel, which is a strictly worse pull request. So the scan is the INBOX and the registry repo
 * is the RECORD: an author publishes by adding a topic, this job writes their pull request for them, and a
 * human merging that diff is the only thing that ever lists anything. Nobody logs in anywhere.
 *
 * The output is deliberately split. `facts` is derived data that overwrites its file every night and needs no
 * review; `proposals` are listings, one pull request each, so a reviewer merges or closes them one at a time
 * and a slow decision on one never blocks the others. `warnings` are for the run summary — things a human
 * should look at, never something this job acts on by itself. Delisting stays manual on purpose: an author
 * whose repo went briefly private should come back to a listing, not to a deletion. */

// Where an extension declares itself, at the repo root. A manifest in a subdirectory is a real shape (one repo,
// several extensions) but not a discoverable one — there is nowhere to look without guessing, so those get
// listed by opening the pull request by hand, which the publish docs say.
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

// owner/repo → the curated entry that already points at it, so a second scan doesn't re-propose a listing.
const listedRepos = (file: RegistryFile): Map<string, string> => {
    const byRepo = new Map<string, string>();
    for (const plugin of file.plugins) {
        const repo = githubRepoOf(resolveSource(plugin.source, "", file.metadata?.pluginRoot));
        if (repo !== undefined) {
            byRepo.set(repo.toLowerCase(), plugin.name);
        }
    }
    return byRepo;
};

/* Read one candidate's manifest and turn it into a proposal, or into the reason it isn't one.
 *
 * The listing key is extensionIdOf(manifest) — `publisher.name`, the same identity the app installs under.
 * Keying the registry by it rather than by a free-text label is what makes squatting a non-event: two
 * publishers can both ship an "incidents" extension without colliding, and a repo that copies somebody
 * else's manifest wholesale collides with the existing listing and gets refused here instead of proposed. */
const propose = async (repo: GithubRepo, github: GithubReader, listed: Map<string, string>): Promise<ListingProposal | string> => {
    if (repo.archived) {
        return `${repo.fullName}: archived`;
    }
    const raw = await github.readFile(repo.fullName, repo.defaultBranch, MANIFEST_PATH);
    if (raw === undefined) {
        return `${repo.fullName}: topic is set but there is no ${MANIFEST_PATH} at the root of ${repo.defaultBranch}`;
    }
    const parsed = ExtensionManifestSchema.safeParse(JSON.parse(raw));
    if (!parsed.success) {
        return `${repo.fullName}: ${MANIFEST_PATH} does not parse — ${parsed.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ")}`;
    }
    const id = extensionIdOf(parsed.data);
    const claimedBy = [...listed.entries()].find(([, name]) => name === id);
    if (claimedBy !== undefined) {
        return `${repo.fullName}: claims ${id}, which is already listed from ${claimedBy[0]}`;
    }
    // Pin the proposal to a real commit. Without one the entry can't be a one-click install, and a listing
    // that can't be installed is not worth a reviewer's time.
    const sha = await github.headSha(repo.fullName, repo.defaultBranch);
    if (sha === undefined) {
        return `${repo.fullName}: no commit found on ${repo.defaultBranch}`;
    }
    return {
        repo: repo.fullName,
        entry: {
            name: id,
            kind: "extension",
            trust: "listed",
            ...(repo.description !== undefined ? { description: repo.description } : {}),
            version: parsed.data.version,
            /* Off the manifest, like the version — an author who has said how their extension should look has
             * said it once, in the file they own, and re-typing it into somebody else's registry repo is how
             * the two would end up disagreeing. Proposed, not enforced: it lands in a pull request a human
             * merges, so a listing can still have its mark struck out or corrected there. */
            ...(parsed.data.logo !== undefined ? { logo: parsed.data.logo } : {}),
            ...(parsed.data.icon !== undefined ? { icon: parsed.data.icon } : {}),
            source: { source: "github", repo: repo.fullName, sha },
        },
    };
};

export const scanRegistry = async (file: RegistryFile, github: GithubReader, scannedAt: string): Promise<ScanResult> => {
    const listed = listedRepos(file);
    const warnings: string[] = [];

    const found = await github.searchByTopic(REGISTRY_TOPIC);
    const foundByRepo = new Map(found.map((repo) => [repo.fullName.toLowerCase(), repo]));

    /* Facts for every listed entry, whether or not the topic found it — a listing arrived at by pull request
     * has no obligation to carry the topic, and dropping its stars because of that would rank it below
     * newcomers for a reason that has nothing to do with it. */
    const entries: RegistryFacts["entries"] = [];
    for (const [repoName, entryName] of listed) {
        const repo = foundByRepo.get(repoName) ?? (await github.getRepo(repoName));
        if (repo === undefined) {
            warnings.push(`${entryName}: source repo ${repoName} is gone or no longer readable — listing may need review`);
            continue;
        }
        if (repo.archived) {
            warnings.push(`${entryName}: source repo ${repoName} is archived`);
        }
        entries.push({ name: entryName, stars: repo.stars, pushedAt: repo.pushedAt });
    }

    // Only what the topic turned up and the file doesn't already carry. Sequential on purpose: a nightly job
    // has all the time in the world and a burst of parallel reads is how you meet a secondary rate limit.
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

    // Sorted so the generated file's diff is the facts that changed, not a reshuffle of the same rows.
    entries.sort((a, b) => a.name.localeCompare(b.name));
    proposals.sort((a, b) => a.entry.name.localeCompare(b.entry.name));
    return { facts: { scannedAt, entries }, proposals, warnings };
};
