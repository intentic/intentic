import { bundleProblem, type ExtensionManifest, ExtensionManifestSchema, extensionIdOf } from "@intentic/extension-manifest";
import { githubRepoOf, type RegistryChecks, type RegistryFacts, type RegistryFile, REGISTRY_TOPIC, resolveSource } from "@intentic/registry";
import type { GithubReader, GithubRepo } from "./github.js";

/* THE SCAN: discovery on one side, a decision on the other, and a pull request in between.
 *
 * Two ideas were on the table for opening the registry up, scan GitHub for a topic and list what it finds,
 * or take submissions through a form on the site. Neither survives alone. A topic is a namespace anybody can
 * join, so a live scan publishes the first malicious repo to push one; a form is a login, a moderation queue
 * and an admin panel, which is a strictly worse pull request. So the scan is the INBOX and the registry repo
 * is the RECORD: an author publishes by adding a topic, this job writes their pull request for them, and a
 * protected admission check plus a human merging that diff are the only things that ever list anything.
 * Nobody logs in anywhere.
 *
 * The output is deliberately split. `facts` is derived data that overwrites its file every night and needs no
 * review; `proposals` are listings, one pull request each, so a reviewer merges or closes them one at a time
 * and a slow decision on one never blocks the others. `warnings` are for the run summary, things a human
 * should look at, never something this job acts on by itself. Delisting stays manual on purpose: an author
 * whose repo went briefly private should come back to a listing, not to a deletion. */

// Where an extension declares itself, at the repo root. A manifest in a subdirectory is a real shape (one repo,
// several extensions) but not a discoverable one, there is nowhere to look without guessing, so those get
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

// owner/repo → the curated entry that already points at it (so a second scan doesn't re-propose a listing) and
// the sha it pins (so the facts pass can re-derive its checks at exactly the commit installs follow).
interface ListedEntry {
    readonly name: string;
    readonly ref: string | undefined;
    // Where the extension sits inside the pinned tree, "" for a repo of its own, the subdir for a monorepo
    // source. The checks must read the manifest where an install would, or a valid listing reads as broken.
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

/* One cold inspection for both an existing listing and a proposal. Sharing this is what keeps discovery from
 * parsing the branch while facts parse the commit: every fact used to create or keep a listing now comes from
 * the exact immutable object the source pointer names. */
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
                manifest: `does not parse — ${parsed.error.issues.map((issue) => `${issue.path.join(".")} ${issue.message}`).join("; ")}`,
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

/* Read one candidate's manifest and turn it into a proposal, or into the reason it isn't one.
 *
 * The listing key is extensionIdOf(manifest), `publisher.name`, the same identity the app installs under.
 * Keying the registry by it rather than by a free-text label is what makes squatting a non-event: two
 * publishers can both ship an "incidents" extension without colliding, and a repo that copies somebody
 * else's manifest wholesale collides with the existing listing and gets refused here instead of proposed. */
const propose = async (repo: GithubRepo, github: GithubReader, listed: Map<string, ListedEntry>): Promise<ListingProposal | string> => {
    if (repo.archived) {
        return `${repo.fullName}: archived`;
    }
    // Pin the proposal to a real commit. Without one the entry can't be a one-click install, and a listing
    // that can't be installed is not worth a reviewer's time.
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
            /* Off the manifest, like the version, an author who has said how their extension should look has
             * said it once, in the file they own, and re-typing it into somebody else's registry repo is how
             * the two would end up disagreeing. Proposed, not enforced: it lands in a pull request a human
             * merges, so a listing can still have its mark struck out or corrected there. */
            ...(manifest.logo !== undefined ? { logo: manifest.logo } : {}),
            ...(manifest.icon !== undefined ? { icon: manifest.icon } : {}),
            source: { source: "github", repo: repo.fullName, sha },
        },
    };
};

/* Reuse the cold inspection at the PINNED sha to answer what an installer would find there, the same questions the daemon's readiness
 * check answers for an author before publishing, asked cold by a stranger holding nothing but the pointer. The
 * bundle rule is shared code (@intentic/extension-manifest), so the two judges cannot drift; what differs is
 * the vantage: the author's check describes the directory they ran it in, this describes the commit installs
 * actually follow. Nothing here is a verdict on trust, it is whether the thing at the pointer can load. */
const checkAtSha = async (fullName: string, entry: ListedEntry, github: GithubReader): Promise<RegistryChecks | undefined> => {
    const sha = entry.ref ?? "";
    return (await inspectAtSha(fullName, sha, entry.path, github)).checks;
};

export const scanRegistry = async (file: RegistryFile, github: GithubReader, scannedAt: string): Promise<ScanResult> => {
    const listed = listedRepos(file);
    const warnings: string[] = [];

    const found = await github.searchByTopic(REGISTRY_TOPIC);
    const foundByRepo = new Map(found.map((repo) => [repo.fullName.toLowerCase(), repo]));

    /* Facts for every listed entry, whether or not the topic found it, a listing arrived at by pull request
     * has no obligation to carry the topic, and dropping its stars because of that would rank it below
     * newcomers for a reason that has nothing to do with it. */
    const entries: RegistryFacts["entries"] = [];
    for (const [repoName, entry] of listed) {
        const repo = foundByRepo.get(repoName) ?? (await github.getRepo(repoName));
        if (repo === undefined) {
            warnings.push(`${entry.name}: source repo ${repoName} is gone or no longer readable — listing may need review`);
            continue;
        }
        if (repo.archived) {
            warnings.push(`${entry.name}: source repo ${repoName} is archived`);
        }
        const checks = entry.ref === undefined ? undefined : await checkAtSha(repo.fullName, entry, github);
        /* A failing check is also a warning, because the facts file is read by browsers and the summary by the
         * maintainer, and the maintainer is the one who can do something about a listing whose pinned commit
         * no longer loads. "none" and "unchecked" are not failures: no bundle is a daemon-only extension, and
         * unchecked means the manifest problem above it already says everything. */
        if (checks !== undefined && checks.manifest !== "ok") {
            warnings.push(`${entry.name}: at the pinned commit, ${checks.manifest}`);
        } else if (checks !== undefined && checks.bundle !== "ok" && checks.bundle !== "none") {
            warnings.push(`${entry.name}: at the pinned commit, the bundle ${checks.bundle}`);
        }
        entries.push({ name: entry.name, stars: repo.stars, pushedAt: repo.pushedAt, ...(checks !== undefined ? { checks } : {}) });
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
