import { access, open, readdir } from "node:fs/promises";
import { join } from "node:path";
import type { Capability, CapabilityRecommendation } from "@intentic/sandbox-contract";
import { defaultGit, type GitRunner } from "@intentic/scaffold";
import { IGNORED_DIRS, REFERENCE_DIR } from "@intentic/workspace-ignore";
import { parseRemote, remoteUrlsOf } from "../git/remote/remote-urls.js";
import { discoverRepos, hasGitEntry } from "../workspace/layout/repo-discovery.js";
import type { DismissedRecommendation } from "./dismissals-store.js";

// Scans /work for capabilities a workspace already implies (a compose file, a git remote), not a model turn, since a
// scan is free, checkable evidence and works before any AI account exists. Every rule names the artifact it read;
// recommendations are advisory, never enabling anything or reading a secret.

const COMPOSE_FILES = new Set(["docker-compose.yml", "docker-compose.yaml", "compose.yml", "compose.yaml"]);
// Komodo's own resource-sync file names: `komodo.toml` and `komodo.<name>.toml|yaml` for split syncs.
const KOMODO_FILE = /^komodo\.[\w.-]*(toml|ya?ml)$/i;
// Matches a compose stack that runs the Komodo core image itself.
const KOMODO_IMAGE = /ghcr\.io\/moghtech\/komodo/i;
// Matches /work's shape: loose root files, one directory per repo; deeper files are a service's own detail.
const SCAN_DEPTH = 2;
// Caps how much of a compose file is read; a hand-written file never approaches this.
const MAX_COMPOSE_BYTES = 64 * 1024;

// Reads only the first MAX_COMPOSE_BYTES bytes, bounding the read itself rather than a post-read slice.
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
    // Workspace-relative paths, root's own files first.
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
    const dirs = entries.filter(
        (entry) =>
            entry.isDirectory() &&
            !entry.name.startsWith(".") &&
            !IGNORED_DIRS.has(entry.name) &&
            // `prefix === ""` marks the workspace root; a repo's own `app/refs/` stays ordinary.
            !(prefix === "" && entry.name === REFERENCE_DIR),
    );
    const below = await Promise.all(dirs.map((entry) => scanFiles(join(dir, entry.name), `${prefix}${entry.name}/`, depth - 1)));
    return {
        compose: [...here.compose, ...below.flatMap((found) => found.compose)],
        komodo: [...here.komodo, ...below.flatMap((found) => found.komodo)],
    };
};

// Docker is its own kind; every connector shares kind `cli` and is told apart by its `provider`.
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
    // Whether this repo carries a GitLab pipeline file; identifies a self-hosted GitLab a hostname alone cannot.
    readonly gitlabCi: boolean;
}

// Every repo's remote plus the fact that disambiguates its host; `origin` leads, so a moved host reads as current.
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

// Bounds only workspace staleness; a connect or decline invalidates the memo via the fingerprint.
const RECOMMENDATIONS_TTL_MS = 10_000;

interface MemoisedRecommendations {
    readonly at: number;
    readonly fingerprint: string;
    readonly result: readonly CapabilityRecommendation[];
}
let memo: MemoisedRecommendations | undefined;

// Connectors are listed before docker, since docker's fix costs a sandbox restart and the rest cost only a token.
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
    // Built after `wanted` so the key is exact; dismissals are sorted, and the NUL byte separates card from evidence.
    const fingerprint = JSON.stringify([root, wanted, dismissed.map((entry) => `${entry.card}\u0000${entry.evidence}`).toSorted()]);
    const now = Date.now();
    if (memo !== undefined && memo.fingerprint === fingerprint && now - memo.at < RECOMMENDATIONS_TTL_MS) {
        return [...memo.result];
    }
    const recommendations: CapabilityRecommendation[] = [];
    // Remotes cost a git spawn per repo, so they're only read when github or gitlab is still wanted.
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
    // A hostname alone catches only gitlab.com and lookalikes; a pipeline file identifies the rest exactly.
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
        // Reads compose file heads only while komodo is still unconnected, to tell it apart from any other stack.
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
    // Dismissals are checked against current evidence, so a card declined for evidence that moved is asked again.
    const result = recommendations.filter(
        (recommendation) => !dismissed.some((entry) => entry.card === recommendation.card && entry.evidence === recommendation.evidence),
    );
    // Stamped with the scan's start time, not its finish, since that's when workspace staleness begins.
    memo = { at: now, fingerprint, result };
    return [...result];
};
