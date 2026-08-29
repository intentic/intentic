import { access, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Capability, CapabilityRecommendation } from "@intentic/sandbox-contract";
import { defaultGit, type GitRunner } from "@intentic/scaffold";
import { IGNORED_DIRS } from "@intentic/workspace-ignore";
import { parseRemote, remoteUrlsOf } from "../git/remote-urls.js";
import { discoverRepos, hasGitEntry } from "../workspace/repo-discovery.js";
import type { DismissedRecommendation } from "./dismissals-store.js";

/* WHAT THE WORKSPACE SAYS IT NEEDS, read off /work rather than asked of the user.
 *
 * The motivating case is still the one that reads worst: the Docker Engine is baked into the base image but
 * dormant, and the container stays unprivileged until the docker capability is added. So a checked-out repo whose
 * dev database is a compose service, `pnpm db:up` in this very repo, fails with a bare "Cannot connect to the
 * Docker daemon", which names neither the capability nor the one-time privileged rebuild that turns it on. The
 * same shape covers the connectors: a workspace of GitHub repos gets an agent that cannot read one issue, and
 * nothing about that failure says a card exists.
 *
 * WHY THIS IS A FILE SCAN AND NOT AN AGENT TURN. Every signal here is a fact, a remote's hostname, a file's
 * name, so a scan answers in milliseconds, for free, with the artifact it read. A model asked the same question
 * returns an impression, and an impression cannot be rendered as evidence the reader can check. It also has to
 * work BEFORE an AI account is connected, which is exactly when these recommendations matter most and exactly
 * when no turn can run.
 *
 * WHAT MAY GO IN HERE. A rule has to be one sentence long, name the artifact it read, and be wrong only in ways
 * the reader can see. `.gitlab-ci.yml` next to a remote is precise (it identifies the instance, url and all);
 * "a Dockerfile therefore probably Kubernetes" is a guess wearing a citation. Recommendations are advisory and
 * evidence-bearing: nothing is enabled automatically, and no secret is ever read out of the workspace, even when
 * one is sitting in a checked-in file. */

const COMPOSE_FILES = new Set(["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"]);
// Komodo's own resource-sync files, which is what a repo that drives a Komodo core carries: `komodo.toml`, and
// the `komodo.<anything>.toml|yaml` spellings its docs use for split syncs.
const KOMODO_FILE = /^komodo\.[\w.-]*(toml|ya?ml)$/i;
// A compose stack that RUNS Komodo, the other half of how people have one, and the half that says the core is
// theirs to point at rather than somebody else's.
const KOMODO_IMAGE = /ghcr\.io\/moghtech\/komodo/i;
// Depth 2 is the shape /work actually takes: loose files at the root, and one directory per repo below it.
// Deeper files are a service's own detail (a repo's _tools/, an example) rather than the thing the user runs,
// and scanning for them would turn a page load into a full-tree walk.
const SCAN_DEPTH = 2;
// A compose file is a page of yaml. Anything past this was not written by hand, and reading a whole one into the
// daemon to look for one image name is how a page load starts depending on the size of a file in the workspace.
const MAX_COMPOSE_BYTES = 64 * 1024;

// The head of a file, read as bytes and never more than the cap. `readFile` + `slice` would bound the SEARCH and
// not the read, which is the half that costs anything.
const headOf = async (path: string): Promise<string> => {
    const handle = await open(path, "r").catch(() => undefined);
    if (handle === undefined) {
        return "";
    }
    try {
        const { buffer, bytesRead } = await handle.read({ buffer: Buffer.alloc(MAX_COMPOSE_BYTES) });
        return buffer.toString("utf8", 0, bytesRead);
    } finally {
        await handle.close();
    }
};

interface ScannedFiles {
    // Workspace-relative paths, in walk order (the root's own files first).
    readonly compose: string[];
    readonly komodo: string[];
}

const scanFiles = async (dir: string, prefix: string, depth: number): Promise<ScannedFiles> => {
    const entries = await readdir(dir, { withFileTypes: true }).catch(() => []);
    const files = entries.filter((entry) => entry.isFile());
    const here: ScannedFiles = {
        compose: files.filter((entry) => COMPOSE_FILES.has(entry.name)).map((entry) => `${prefix}${entry.name}`),
        komodo: files.filter((entry) => KOMODO_FILE.test(entry.name)).map((entry) => `${prefix}${entry.name}`),
    };
    if (depth === 0) {
        return here;
    }
    const dirs = entries.filter((entry) => entry.isDirectory() && !entry.name.startsWith(".") && !IGNORED_DIRS.has(entry.name));
    const below = await Promise.all(dirs.map((entry) => scanFiles(join(dir, entry.name), `${prefix}${entry.name}/`, depth - 1)));
    return {
        compose: [...here.compose, ...below.flatMap((found) => found.compose)],
        komodo: [...here.komodo, ...below.flatMap((found) => found.komodo)],
    };
};

// Whether a card already has a connection. The docker card IS its own kind; every connector shares the single
// `cli` kind and is told apart by the provider its card pins, which is also why a recommendation names a CARD.
const isConnected = (active: readonly Capability[], card: string): boolean =>
    active.some((capability) => capability.kind === card || (capability.kind === "cli" && capability.config.provider === card));

const fileExists = (path: string): Promise<boolean> =>
    access(path).then(
        () => true,
        () => false,
    );

interface RepoRemote {
    readonly repo: string;
    readonly host: string;
    readonly project: string;
    // Whether this repo also carries a GitLab pipeline, what identifies a self-hosted GitLab, whose hostname
    // says nothing on its own.
    readonly gitlabCi: boolean;
}

// Every workspace repo that has a remote worth reading, with the one local fact that disambiguates its host.
// `origin` leads each repo's list (remoteUrlsOf), so a repo that moved hosts is read as living at the new one.
const repoRemotes = async (root: string, git: GitRunner): Promise<RepoRemote[]> => {
    const repos = await discoverRepos(root);
    if (await hasGitEntry(root)) {
        repos.unshift("root");
    }
    const found = await Promise.all(
        repos.map(async (repo): Promise<RepoRemote[]> => {
            const dir = repo === "root" ? root : join(root, repo);
            const [urls, gitlabCi] = await Promise.all([remoteUrlsOf(dir, git), fileExists(join(dir, ".gitlab-ci.yml"))]);
            return urls.flatMap((url) => {
                const remote = parseRemote(url);
                return remote === undefined ? [] : [{ repo, host: remote.host, project: remote.project, gitlabCi }];
            });
        }),
    );
    return found.flat();
};

/* HOW LONG A SCAN'S ANSWER STANDS, and why this read is memoised at all.
 *
 * Everything below is a WORKSPACE scan: a repo walk, a `git remote -v` per repo, a depth-2 directory walk, and
 * the head of each compose file. It runs unconditionally on every GET /capabilities, and that route is polled by
 * every connected browser for as long as the Capabilities view (or the setup guide) is on screen, so the same
 * walk was being paid hundreds of times an hour to answer a question whose inputs move at human speed: somebody
 * clones a repo, adds a compose file, connects a card.
 *
 * WHAT THE FINGERPRINT COVERS is the half that must never go stale. The result depends on `active` ONLY through
 * `wanted` (the still-unconnected cards) and on `dismissed` directly, so both ride the key: connecting a card or
 * declining a recommendation changes the fingerprint and the next read is a fresh scan, with no window in which
 * the panel could show a card the owner just connected. That is the case a bare timer would have got wrong.
 *
 * THE TTL COVERS ONLY THE WORKSPACE, the input no fingerprint can see: a repo cloned or a compose file written
 * since the last scan. Ten seconds is chosen against what that costs when it is wrong, which is that a newly
 * cloned GitHub repo takes up to ten seconds to suggest connecting GitHub. Nothing here is load-bearing enough
 * to want a file watcher for; a recommendation is advisory by construction. */
const RECOMMENDATIONS_TTL_MS = 10_000;

interface MemoisedRecommendations {
    readonly at: number;
    readonly fingerprint: string;
    readonly result: readonly CapabilityRecommendation[];
}
let memo: MemoisedRecommendations | undefined;

/* THE ORDER RECOMMENDATIONS ARE MADE IN, which is also the order the guided setup walks them: the connectors
 * first, because they cost a token and nothing else, and docker last, because it costs a restart of the sandbox
 * the user is sitting in. Putting the disruptive one first would make the whole set feel like it costs that. */
export const capabilityRecommendations = async (
    root: string,
    active: readonly Capability[],
    dismissed: readonly DismissedRecommendation[],
    git: GitRunner = defaultGit,
): Promise<CapabilityRecommendation[]> => {
    const wanted = ["github", "gitlab", "komodo", "docker"].filter((card) => !isConnected(active, card));
    if (wanted.length === 0) {
        return [];
    }
    /* Built AFTER `wanted`, which costs nothing (it reads the list already in hand) and is what makes the key
     * exact rather than approximate. Dismissals are sorted so two equal sets cannot produce two keys; `\u0000`
     * separates the pair's halves because it is the one character neither a card name nor a file path holds. */
    const fingerprint = JSON.stringify([root, wanted, dismissed.map((entry) => `${entry.card}\u0000${entry.evidence}`).toSorted()]);
    const now = Date.now();
    if (memo !== undefined && memo.fingerprint === fingerprint && now - memo.at < RECOMMENDATIONS_TTL_MS) {
        return [...memo.result];
    }
    const recommendations: CapabilityRecommendation[] = [];
    // Remotes cost a git spawn per repo, so they are only read when a card that depends on them is still open.
    const remotes = wanted.includes("github") || wanted.includes("gitlab") ? await repoRemotes(root, git) : [];
    const github = remotes.find((remote) => remote.host === "github.com");
    if (wanted.includes("github") && github !== undefined) {
        recommendations.push({
            card: "github",
            evidence: `${github.repo} → ${github.host}/${github.project}`,
            reason: `your repositories are hosted on GitHub`,
            prefill: {},
        });
    }
    // A hostname alone only catches gitlab.com and the instances polite enough to be named after it; the
    // pipeline file next to the remote is what identifies the rest, and it identifies them exactly, which is
    // what lets the instance url be filled in rather than asked for.
    const gitlab = remotes.find((remote) => remote.host === "gitlab.com" || remote.host.includes("gitlab") || remote.gitlabCi);
    if (wanted.includes("gitlab") && gitlab !== undefined) {
        recommendations.push({
            card: "gitlab",
            evidence: gitlab.gitlabCi ? `${gitlab.repo}/.gitlab-ci.yml → ${gitlab.host}` : `${gitlab.repo} → ${gitlab.host}/${gitlab.project}`,
            reason: gitlab.host === "gitlab.com" ? `your repositories are hosted on GitLab` : `your repositories are hosted on your own GitLab`,
            prefill: { url: `https://${gitlab.host}` },
        });
    }
    const files = await scanFiles(root, "", SCAN_DEPTH);
    if (wanted.includes("komodo")) {
        const sync = files.komodo[0];
        // Reading the compose files is the price of telling "runs Komodo" from "runs anything else", only paid
        // while the komodo card is still unconnected, and only for the head of each file.
        const stacks = await Promise.all(files.compose.map(async (path) => (KOMODO_IMAGE.test(await headOf(join(root, path))) ? path : undefined)));
        const evidence = sync ?? stacks.find((path) => path !== undefined);
        if (evidence !== undefined) {
            recommendations.push({
                card: "komodo",
                evidence,
                reason: sync === undefined ? `your workspace runs Komodo in a compose stack` : `your workspace drives a Komodo core`,
                prefill: {},
            });
        }
    }
    const compose = files.compose[0];
    if (wanted.includes("docker") && compose !== undefined) {
        recommendations.push({ card: "docker", evidence: compose, reason: `your workspace has a compose stack to run`, prefill: {} });
    }
    // Dropped last, against the evidence as it stands NOW: a card declined for a remote that has since moved is
    // being asked about a different thing, and asking again is the point.
    const result = recommendations.filter(
        (recommendation) => !dismissed.some((entry) => entry.card === recommendation.card && entry.evidence === recommendation.evidence),
    );
    // Stamped with the time the scan STARTED, not the time it finished: the TTL bounds how stale the workspace
    // reading may be, and that staleness begins when the directories were read.
    memo = { at: now, fingerprint, result };
    return [...result];
};
