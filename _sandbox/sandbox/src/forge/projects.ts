import type { GitHost } from "../capabilities/cli/git-access.js";

export class WorkspaceRemoteError extends Error {}
export class GitlabProjectError extends Error {}

export interface ForgeProject {
    // Workspace repo dir ("root" for the workspace repo itself); the id triggers and the view join on.
    readonly repo: string;
    // owner/name (github) or the full namespaced path (gitlab); what the provider API addresses.
    readonly project: string;
    // The connected account serving this repo's host: provider, hostname, REST base, token.
    readonly account: GitHost;
}

// The project's page on the connected instance, including its configured scheme.
export const projectPage = (project: ForgeProject): string => `${project.account.scheme}://${project.account.host}/${project.project}`;
