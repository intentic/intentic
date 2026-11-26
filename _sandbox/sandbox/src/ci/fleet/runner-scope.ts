import { defaultGit, type GitRunner } from "@intentic/base/git";
import { ORPCError } from "@orpc/server";
import { forgeAccounts, type GitHost } from "../../capabilities/cli/git-access.js";
import type { CapabilitiesStore } from "../../capabilities/capabilities-store.js";
import { parseRemote, remoteUrlsOf } from "../../git/remote/remote-urls.js";
import { repoFolder } from "../../hosts/stacks/device-stack-bundle.js";
import type { RunnerScope } from "../../forge/github.js";

// Registration resolves the workspace repository's remote. Removal uses the URL from the runner's own configuration.

// The only host the machine's register tool takes a runner for (CiRunnerRegisterArgsSchema's url): github.com itself.
const GITHUB_HOST = "github.com";

const githubAccount = async (capabilities: CapabilitiesStore, doing: string): Promise<GitHost> => {
    const account = (await forgeAccounts(capabilities)).find((candidate) => candidate.provider === "github" && candidate.host === GITHUB_HOST);
    if (account === undefined) {
        throw new ORPCError("FORBIDDEN", {
            message: `${doing} takes a token GitHub mints for the repository, through this sandbox's GitHub connection, and none is connected: connect GitHub under Capabilities, with an account that has admin on the repository, then try again.`,
        });
    }
    return account;
};

/** The GitHub repository a workspace repository's remote names, on the connected GitHub account, as a runner is
 *  registered to it. `origin` is asked first, as the CI mapping does (ci/projects.ts). */
export const registrationScope = async (
    services: { readonly workspace: { readonly root: string }; readonly capabilities: CapabilitiesStore },
    repo: string,
    git: GitRunner = defaultGit,
): Promise<RunnerScope> => {
    const account = await githubAccount(services.capabilities, "Registering a runner");
    const dir = await repoFolder(services.workspace.root, repo);
    for (const url of await remoteUrlsOf(dir, git)) {
        const remote = parseRemote(url);
        if (remote?.host === GITHUB_HOST && /^[^/]+\/[^/]+$/.test(remote.project)) {
            return { url: `https://${GITHUB_HOST}/${remote.project}`, api: `repos/${remote.project}`, account };
        }
    }
    throw new ORPCError("BAD_REQUEST", { message: `"${repo}" has no remote on github.com, so there is no GitHub repository to register a runner for.` });
};

/** Where an existing runner is registered, read from the `url` its own `.runner` file holds; the connected GitHub
 *  account mints its removal token. */
export const removalScope = async (capabilities: CapabilitiesStore, name: string, url: string | undefined): Promise<RunnerScope> => {
    const parsed = url === undefined ? undefined : URL.parse(url);
    const parts = parsed?.pathname.split("/").filter((part) => part !== "") ?? [];
    if (parsed?.host !== GITHUB_HOST || parts.length < 1 || parts.length > 2) {
        throw new ORPCError("BAD_REQUEST", {
            message:
                url === undefined
                    ? `The runner "${name}" does not say what it is registered to, so no removal token can be minted for it.`
                    : `The runner "${name}" is registered to ${url}, which is not a github.com repository or organisation this sandbox can mint a removal token for.`,
        });
    }
    const account = await githubAccount(capabilities, "Removing a runner");
    const path = parts.join("/");
    return { url: `https://${GITHUB_HOST}/${path}`, api: parts.length === 2 ? `repos/${path}` : `orgs/${path}`, account };
};
