import type { Capability, IntentSet } from "@intentic/need-resolver";

// A concrete way to satisfy one or more capabilities; one option can fill several needs at once, e.g. forgejo
// provides both source-control and docker-registry.
export interface Option {
    readonly id: string;
    readonly provides: readonly Capability[];
}

export interface Catalog {
    optionsFor(capability: Capability): readonly Option[];
}

// Forgejo+Komodo stack: self-hosted git, CI, registry, deploy orchestration; the default stack.
const forgejoOptions: readonly Option[] = [
    { id: "forgejo", provides: ["source-control", "docker-registry"] },
    { id: "komodo", provides: ["infra-control"] },
    { id: "ssh-linux", provides: ["deployment-target"] },
    { id: "cloudflare-tunnel", provides: ["domain"] },
];

// GitHub stack: hosted git+CI (Actions)+registry (GHCR); Komodo still deploys, so CI only builds and pushes.
const githubOptions: readonly Option[] = [
    { id: "github", provides: ["source-control", "docker-registry"] },
    { id: "komodo", provides: ["infra-control"] },
    { id: "ssh-linux", provides: ["deployment-target"] },
    { id: "cloudflare-tunnel", provides: ["domain"] },
];

// GitLab stack: hosted or self-hosted git+CI (.gitlab-ci.yml)+registry; Komodo deploys, like the GitHub stack.
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

// Selects the catalog: i.have.github ⇒ GitHub stack, i.have.gitlab ⇒ GitLab stack, otherwise Forgejo+Komodo. The
// SDK enforces at most one of github/gitlab.
export const catalogFor = (intent: IntentSet): Catalog => {
    if (intent.github !== undefined) {
        return githubCatalog;
    }
    if (intent.gitlab !== undefined) {
        return gitlabCatalog;
    }
    return forgejoCatalog;
};
