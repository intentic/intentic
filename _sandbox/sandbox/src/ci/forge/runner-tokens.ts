import { defaultGit, type GitRunner } from "@intentic/base/git";
import { parseJsonWith } from "@intentic/base/json";
import { ORPCError } from "@orpc/server";
import { z } from "zod";
import { type GitHost, githubHeaders } from "../../capabilities/cli/git-access.js";
import type { CapabilitiesStore } from "../../capabilities/capabilities-store.js";
import { CiRateLimited, CiRefused, throwOn } from "../forge-refusals.js";
import { forgeAccounts } from "../projects.js";
import type { FetchFn } from "../providers.js";
import { parseRemote, remoteUrlsOf } from "../../git/remote/remote-urls.js";
import { repoFolder } from "../../hosts/stacks/device-stack-bundle.js";

// THE TOKENS GITHUB HANDS OUT FOR ADDING AND REMOVING A SELF-HOSTED RUNNER, minted here through the workspace's GitHub
// connection (the account ci/projects.ts maps a repository's remote to) and handed straight to the machine's
// `ci_runner_register` or `ci_runner_remove`. Each is good for an hour and for that one repository, so nothing keeps
// one: it is minted for the call, passed on, and dropped, and no log or error message here ever carries it.

/** Where a runner is registered at GitHub: the `url` config.sh takes, and the REST path its tokens are minted under. */
export interface RunnerScope {
    // https://github.com/<owner>/<repo>, or https://github.com/<org> for an organisation's runner.
    readonly url: string;
    // `repos/<owner>/<repo>` or `orgs/<org>`.
    readonly api: string;
    readonly account: GitHost;
}

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

export type RunnerTokenKind = "registration" | "remove";

const TokenSchema = z.object({ token: z.string().min(1) });

// GitHub's refusal, in what it means for the person: a token it no longer takes, a token without admin on the
// repository (GitHub answers 404 rather than 403 to a token that may not see the repository's runners), a spent rate
// limit, or anything else, said with its status.
const tokenRefusal = (error: Error, scope: RunnerScope, kind: RunnerTokenKind): ORPCError<string, unknown> => {
    const what = `a runner ${kind === "registration" ? "registration" : "removal"} token for ${scope.url}`;
    if (error instanceof CiRateLimited) {
        return new ORPCError("TOO_MANY_REQUESTS", { message: `GitHub would not mint ${what}: the connection's rate limit is spent until ${new Date(error.until).toISOString()}.` });
    }
    if (error instanceof CiRefused && error.status === 401) {
        return new ORPCError("FORBIDDEN", { message: `GitHub no longer accepts the connected account's token, so it would not mint ${what}: reconnect GitHub under Capabilities.` });
    }
    if (error instanceof CiRefused && (error.status === 403 || error.status === 404)) {
        return new ORPCError("FORBIDDEN", {
            message: `GitHub refused to mint ${what} (${error.status}): the connected GitHub account needs admin on ${scope.api.replace(/^(repos|orgs)\//, "")} (a fine-grained token's "Administration: read and write"). Grant it, or connect an account that has it, then try again.`,
        });
    }
    return new ORPCError("BAD_GATEWAY", { message: `GitHub did not mint ${what}: ${error.message}` });
};

/** A fresh registration or removal token for the scope, from GitHub's REST API. The token is returned and never kept. */
export const mintRunnerToken = async (scope: RunnerScope, kind: RunnerTokenKind, fetchFn: FetchFn = fetch): Promise<string> => {
    const url = `${scope.account.apiBase}/${scope.api}/actions/runners/${kind === "registration" ? "registration-token" : "remove-token"}`;
    const what = `github runner ${kind} token`;
    const response = await fetchFn(url, { method: "POST", headers: githubHeaders(scope.account.token) })
        .then(async (answer) => await throwOn(answer, what))
        .catch((error: Error) => {
            throw tokenRefusal(error, scope, kind);
        });
    const minted = parseJsonWith(await response.text(), TokenSchema);
    if (minted === undefined) {
        throw new ORPCError("BAD_GATEWAY", { message: `GitHub answered the ${kind} token request for ${scope.url} without a token.` });
    }
    return minted.token;
};
