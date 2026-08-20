import type { Capability, IntentSet } from "@intentic/need-resolver";

// A concrete way to satisfy one or more capabilities. One option can fill several needs at once. Forgejo
// (the "Gitea" option) provides both source control and a Docker registry, which couples those needs to
// the same choice.
export interface Option {
    readonly id: string;
    readonly provides: readonly Capability[];
}

export interface Catalog {
    optionsFor(capability: Capability): readonly Option[];
}

// The Forgejo+Komodo stack: self-hosted git, CI, registry, and deploy orchestration. Default when no
// i.have.github is declared.
const forgejoOptions: readonly Option[] = [
    { id: "forgejo", provides: ["source-control", "docker-registry"] },
    { id: "komodo", provides: ["infra-control"] },
    { id: "ssh-linux", provides: ["deployment-target"] },
    { id: "cloudflare-tunnel", provides: ["domain"] },
];

// The GitHub stack: hosted git + CI (GitHub Actions) + registry (GHCR). Komodo still fills infra-control,
// the deploy orchestrator is unconditional, so CI only builds + pushes and the host stays outbound-only.
// Selected when i.have.github is declared.
const githubOptions: readonly Option[] = [
    { id: "github", provides: ["source-control", "docker-registry"] },
    { id: "komodo", provides: ["infra-control"] },
    { id: "ssh-linux", provides: ["deployment-target"] },
    { id: "cloudflare-tunnel", provides: ["domain"] },
];

// The GitLab stack: hosted (or self-hosted) git + CI (.gitlab-ci.yml) + registry (GitLab Container Registry).
// Komodo fills infra-control exactly like the GitHub stack. Selected when i.have.gitlab is declared.
const gitlabOptions: readonly Option[] = [
    { id: "gitlab", provides: ["source-control", "docker-registry"] },
    { id: "komodo", provides: ["infra-control"] },
    { id: "ssh-linux", provides: ["deployment-target"] },
    { id: "cloudflare-tunnel", provides: ["domain"] },
];

const makeCatalog = (options: readonly Option[]): Catalog =>
    Object.freeze({ optionsFor: (capability: Capability): readonly Option[] => options.filter((option) => option.provides.includes(capability)) });

export const forgejoCatalog: Catalog = makeCatalog(forgejoOptions);
export const githubCatalog: Catalog = makeCatalog(githubOptions);
export const gitlabCatalog: Catalog = makeCatalog(gitlabOptions);

// Select the catalog based on the intent: i.have.github ⇒ the GitHub stack, i.have.gitlab ⇒ the GitLab stack;
// otherwise the self-hosted Forgejo+Komodo default. The SDK enforces a single source-control account, so at
// most one of github/gitlab is set.
export const catalogFor = (intent: IntentSet): Catalog => {
    if (intent.github !== undefined) {
        return githubCatalog;
    }
    if (intent.gitlab !== undefined) {
        return gitlabCatalog;
    }
    return forgejoCatalog;
};
