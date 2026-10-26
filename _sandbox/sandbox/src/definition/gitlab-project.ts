import { errorMessage } from "@intentic/base/errors";
import { z } from "zod";
import type { GitHost } from "../capabilities/cli/git-access.js";

// Creating the project a publish pushes /work into, on a GitLab instance. GitLab answers a create in a namespace the
// token may not use with a bare 400 {"namespace":["is not valid"]}, which is what a group or project access token got
// here: its bot user has a personal namespace nobody may create projects in (2026-10-26, a project token on a
// self-hosted 18.6). So the namespace is chosen first: the one the owner named, else the token's own for a person, else
// the group a group token belongs to; a project token can create nothing, and says so with the project it can push to.

export class GitlabProjectError extends Error {}

export type GitlabFetch = (url: string, init?: { readonly method?: string; readonly headers?: Record<string, string>; readonly body?: string }) => Promise<Response>;

const UserSchema = z.object({ bot: z.boolean().optional() });
const NamespaceSchema = z.object({ id: z.number(), full_path: z.string() });
const NamespacesSchema = z.array(NamespaceSchema);
const ProjectsSchema = z.array(z.object({ path_with_namespace: z.string() }));
const CreatedSchema = z.object({ path_with_namespace: z.string().optional(), http_url_to_repo: z.string().optional() });

// Developer: the least a member needs to create a project in a group under GitLab's default creation setting.
const DEVELOPER = 30;

// The instance's own address (the card's url), which the token's credential line was written for.
const instanceBase = (host: GitHost): string => host.apiBase.replace(/\/api\/v4$/u, "");

// GitLab's own words for a refusal; a body that cannot be read says why instead.
const bodyText = async (response: Response): Promise<string> => {
    try {
        return await response.text();
    } catch (error) {
        return `(its answer could not be read: ${errorMessage(error)})`;
    }
};

// A body parsed as JSON, or why it could not be: the caller names the failure rather than meeting an empty object.
const jsonBody = async (response: Response): Promise<{ readonly value: unknown } | { readonly unreadable: string }> => {
    try {
        return { value: await response.json() };
    } catch (error) {
        return { unreadable: errorMessage(error) };
    }
};

const refused = async (host: GitHost, what: string, response: Response): Promise<GitlabProjectError> =>
    new GitlabProjectError(`${host.host} refused ${what}: ${response.status} ${await bodyText(response)}`.trim());

const getJson = async <T>(host: GitHost, fetcher: GitlabFetch, path: string, schema: z.ZodType<T>, what: string): Promise<T> => {
    const response = await fetcher(`${host.apiBase}${path}`, { headers: { "PRIVATE-TOKEN": host.token } });
    if (!response.ok) {
        throw await refused(host, what, response);
    }
    const body = await jsonBody(response);
    if ("unreadable" in body) {
        throw new GitlabProjectError(`${host.host} answered ${what} with something that is not JSON: ${body.unreadable}`);
    }
    const parsed = schema.safeParse(body.value);
    if (!parsed.success) {
        throw new GitlabProjectError(`${host.host} answered ${what} with something that is not GitLab's shape`);
    }
    return parsed.data;
};

// Where the project goes: undefined is the token's own personal namespace, which only a person's token may use.
const namespaceFor = async (host: GitHost, owner: string | undefined, fetcher: GitlabFetch): Promise<number | undefined> => {
    if (owner !== undefined) {
        const response = await fetcher(`${host.apiBase}/namespaces/${encodeURIComponent(owner)}`, { headers: { "PRIVATE-TOKEN": host.token } });
        if (response.status === 404) {
            throw new GitlabProjectError(`${host.host} has no group or user "${owner}" this token can see`);
        }
        if (!response.ok) {
            throw await refused(host, `to look up "${owner}"`, response);
        }
        return NamespaceSchema.parse(await response.json()).id;
    }
    const user = await getJson(host, fetcher, "/user", UserSchema, "to say whose token this is");
    if (user.bot !== true) {
        return undefined;
    }
    const groups = await getJson(host, fetcher, `/groups?min_access_level=${String(DEVELOPER)}&per_page=100`, NamespacesSchema, "to list its groups");
    const group = groups.toSorted((a, b) => a.full_path.length - b.full_path.length || a.full_path.localeCompare(b.full_path))[0];
    if (group !== undefined) {
        return group.id;
    }
    const projects = await getJson(host, fetcher, "/projects?membership=true&per_page=20", ProjectsSchema, "to list its projects");
    const reach = projects.length === 0 ? "" : ` It can push to ${projects.map((project) => project.path_with_namespace).join(", ")}.`;
    throw new GitlabProjectError(
        `the GitLab card's token is a project access token, which GitLab does not let create projects.${reach} To publish, ` +
            `create an empty project on ${host.host} and paste its URL, or connect a personal or group access token with the api scope.`,
    );
};

// POST /projects as GitLab reads it; no namespace_id is the token's own personal namespace.
interface GitlabCreateRequest {
    readonly name: string;
    readonly path: string;
    readonly visibility: "private";
    namespace_id?: number;
}

/** Creates a private project for the workspace and answers its clone URL on the card's own address. */
export const createGitlabProject = async (host: GitHost, name: string, owner: string | undefined, fetcher: GitlabFetch = fetch): Promise<string> => {
    const namespaceId = await namespaceFor(host, owner, fetcher);
    const request: GitlabCreateRequest = { name, path: name, visibility: "private" };
    if (namespaceId !== undefined) {
        request.namespace_id = namespaceId;
    }
    const response = await fetcher(`${host.apiBase}/projects`, {
        method: "POST",
        headers: { "PRIVATE-TOKEN": host.token, "Content-Type": "application/json" },
        body: JSON.stringify(request),
    });
    if (!response.ok) {
        throw await refused(host, `to create "${name}"`, response);
    }
    const answer = await jsonBody(response);
    if ("unreadable" in answer) {
        throw new GitlabProjectError(`${host.host} created "${name}" but its answer is not JSON (${answer.unreadable}); the project may exist there now`);
    }
    const body = CreatedSchema.safeParse(answer.value).data ?? {};
    // GitLab spells its clone URL from its own external_url, which need not be the address this sandbox reaches it at
    // (and holds the credential for); the project's path on the card's address is the same repository.
    if (body.path_with_namespace !== undefined && body.path_with_namespace !== "") {
        return `${instanceBase(host)}/${body.path_with_namespace}.git`;
    }
    if (body.http_url_to_repo !== undefined && body.http_url_to_repo !== "") {
        return body.http_url_to_repo;
    }
    throw new GitlabProjectError(`${host.host} created the project but returned no clone URL`);
};
