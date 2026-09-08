import { z } from "zod";
import { parseResponse } from "../core/inputs.js";
import { responseDetail } from "../core/response-detail.js";

// Admin connection every call carries: instance location and admin credentials. Auth flows per-call as HTTP
// Basic rather than baked into the adapter, so one process can drive several instances.
export interface ForgejoAdmin {
    readonly baseUrl: string;
    readonly user: string;
    readonly password: string;
}

// A repo's clone and ssh urls. Forgejo returns resource JSON directly, no envelope; unread fields are dropped.
export interface ForgejoRepo {
    readonly cloneUrl: string;
    readonly sshUrl: string;
}

// A Forgejo org team: its numeric id (needed to add members/repos) and the permission it grants on its repos.
export interface ForgejoTeam {
    readonly id: number;
    readonly permission: string;
}

const rawRepoSchema = z.object({ clone_url: z.string(), ssh_url: z.string() });
const rawCommitSchema = z.object({ sha: z.string() });
const rawContentSchema = z.object({ sha: z.string() });
const rawTeamSchema = z.object({ id: z.number(), permission: z.string() });

// Percent-encodes each path segment; slashes are kept as path separators.
const encodePath = (path: string): string => path.split("/").map(encodeURIComponent).join("/");

export const forgejoHookSchema = z.object({
    id: z.number(),
    type: z.string(),
    config: z.record(z.string(), z.string()),
    events: z.array(z.string()),
    active: z.boolean(),
});
export type ForgejoHook = z.infer<typeof forgejoHookSchema>;

// Slice of the Forgejo v4 API the repo/ci/notify providers use; injected so they're testable with a fake, with
// `forgejoApi` below as the default implementation over native fetch.
export interface ForgejoApi {
    // A repo under `owner`; undefined if it does not exist (404).
    readonly findRepo: (
        args: ForgejoAdmin & {
            readonly owner: string;
            readonly name: string;
        },
    ) => Promise<ForgejoRepo | undefined>;
    // Creates a repo owned by `owner`; `ownerIsOrg` picks org vs admin-for-user endpoint. `autoInit` writes an
    // initial commit; pass false for an empty repo when local history will be pushed in.
    readonly createRepo: (
        args: ForgejoAdmin & {
            readonly owner: string;
            readonly ownerIsOrg: boolean;
            readonly name: string;
            readonly private: boolean;
            readonly autoInit: boolean;
        },
    ) => Promise<ForgejoRepo>;
    // A user exists (by username). Public endpoint; admin Basic auth is fine.
    readonly findUser: (
        args: ForgejoAdmin & {
            readonly username: string;
        },
    ) => Promise<boolean>;
    // Creates a git account; `mustChangePassword` forced false, or Forgejo defaults it true and locks the account out
    // until a rotation.
    readonly createUser: (
        args: ForgejoAdmin & {
            readonly username: string;
            readonly email: string;
            readonly accountPassword: string;
        },
    ) => Promise<void>;
    // An organization exists (by login).
    readonly findOrg: (
        args: ForgejoAdmin & {
            readonly org: string;
        },
    ) => Promise<boolean>;
    // Create an organization owned by the admin `user`, keeping full access to the org's private repos that Komodo
    // clones and pulls.
    readonly createOrg: (args: ForgejoAdmin & { readonly org: string }) => Promise<void>;
    // A team in an org (by name); undefined if absent. Returns the numeric id member/repo grants need.
    readonly findTeam: (
        args: ForgejoAdmin & {
            readonly org: string;
            readonly name: string;
        },
    ) => Promise<ForgejoTeam | undefined>;
    // Create a team in an org at `permission` (read|write|admin) granting access to the repos it is attached to.
    readonly createTeam: (
        args: ForgejoAdmin & {
            readonly org: string;
            readonly name: string;
            readonly permission: string;
        },
    ) => Promise<ForgejoTeam>;
    // Add a user to a team (idempotent PUT).
    readonly addTeamMember: (
        args: ForgejoAdmin & {
            readonly teamId: number;
            readonly username: string;
        },
    ) => Promise<void>;
    // Attach a repo to a team, granting its members the team's permission on it (idempotent PUT).
    readonly addTeamRepo: (
        args: ForgejoAdmin & {
            readonly teamId: number;
            readonly org: string;
            readonly name: string;
        },
    ) => Promise<void>;
    // Every webhook on a repo, for stateless re-attribution (matched by type + config.url).
    readonly listHooks: (
        args: ForgejoAdmin & {
            readonly owner: string;
            readonly name: string;
        },
    ) => Promise<readonly ForgejoHook[]>;
    // Create a webhook (type "discord" for notifications, "gitea" for the Komodo deploy listener).
    readonly createHook: (
        args: ForgejoAdmin & {
            readonly owner: string;
            readonly name: string;
            readonly type: string;
            readonly config: Readonly<Record<string, string>>;
            readonly events: readonly string[];
        },
    ) => Promise<void>;
    // Replace an existing webhook's config + events in place.
    readonly updateHook: (
        args: ForgejoAdmin & {
            readonly owner: string;
            readonly name: string;
            readonly id: number;
            readonly config: Readonly<Record<string, string>>;
            readonly events: readonly string[];
        },
    ) => Promise<void>;
    // The latest commit sha on `branch`; undefined when the repo has no commits on it yet.
    readonly latestCommit: (
        args: ForgejoAdmin & {
            readonly owner: string;
            readonly name: string;
            readonly branch: string;
        },
    ) => Promise<string | undefined>;
    // The raw contents of `path` on `branch`; undefined if it does not exist (404).
    readonly readFile: (
        args: ForgejoAdmin & {
            readonly owner: string;
            readonly name: string;
            readonly branch: string;
            readonly path: string;
        },
    ) => Promise<string | undefined>;
    // Create or replace `path` on `branch` with `content` (utf-8), committing with `message`.
    readonly commitFile: (
        args: ForgejoAdmin & {
            readonly owner: string;
            readonly name: string;
            readonly branch: string;
            readonly path: string;
            readonly content: string;
            readonly message: string;
        },
    ) => Promise<void>;
    // Create or replace a repo Actions secret consumed by the CI workflow; Forgejo accepts the plaintext value directly
    // as `data`.
    readonly setRepoSecret: (
        args: ForgejoAdmin & {
            readonly owner: string;
            readonly name: string;
            readonly secretName: string;
            readonly data: string;
        },
    ) => Promise<void>;
    // Teardown surface prune drives; each call is idempotent, a 404 counts as success. Deletes a repo (and all
    // content); `owner` is the org or admin user it lives under.
    readonly deleteRepo: (
        args: ForgejoAdmin & {
            readonly owner: string;
            readonly name: string;
        },
    ) => Promise<void>;
    // Delete `path` on `branch`, committing with `message` (looks up the current blob sha the API requires).
    readonly deleteFile: (
        args: ForgejoAdmin & {
            readonly owner: string;
            readonly name: string;
            readonly branch: string;
            readonly path: string;
            readonly message: string;
        },
    ) => Promise<void>;
    // Delete a repo Actions secret by name.
    readonly deleteRepoSecret: (
        args: ForgejoAdmin & {
            readonly owner: string;
            readonly name: string;
            readonly secretName: string;
        },
    ) => Promise<void>;
    // Delete a webhook by id.
    readonly deleteHook: (
        args: ForgejoAdmin & {
            readonly owner: string;
            readonly name: string;
            readonly id: number;
        },
    ) => Promise<void>;
    // Delete a user account (admin endpoint; `purge` removes its repos/issues too).
    readonly deleteUser: (
        args: ForgejoAdmin & {
            readonly username: string;
        },
    ) => Promise<void>;
    // Delete an organization by login.
    readonly deleteOrg: (args: ForgejoAdmin & { readonly org: string }) => Promise<void>;
    // Delete a team by its numeric id.
    readonly deleteTeam: (
        args: ForgejoAdmin & {
            readonly teamId: number;
        },
    ) => Promise<void>;
}

const authHeader = (user: string, password: string): string => `Basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;

const request = async (args: {
    readonly method: string;
    readonly baseUrl: string;
    readonly path: string;
    readonly user: string;
    readonly password: string;
    readonly body?: unknown;
}): Promise<Response> =>
    fetch(`${args.baseUrl}/api/v1${args.path}`, {
        method: args.method,
        headers: {
            Authorization: authHeader(args.user, args.password),
            ...(args.body !== undefined ? { "Content-Type": "application/json" } : {}),
        },
        ...(args.body !== undefined ? { body: JSON.stringify(args.body) } : {}),
        // Bound a stalled connection (undici's default headers timeout is ~5 minutes).
        signal: AbortSignal.timeout(30_000),
    });

const ok = async (response: Response, method: string, path: string): Promise<Response> => {
    if (!response.ok) {
        throw new Error(`Forgejo API ${method} ${path} failed (HTTP ${response.status}): ${await responseDetail(response)}`);
    }
    return response;
};

// A delete that is idempotent: a 404 means the resource is already gone, which is the desired end state.
const okOrMissing = async (response: Response, method: string, path: string): Promise<void> => {
    if (response.status === 404) {
        return;
    }
    await ok(response, method, path);
};

const toRepo = (raw: z.infer<typeof rawRepoSchema>): ForgejoRepo => ({ cloneUrl: raw.clone_url, sshUrl: raw.ssh_url });

export const forgejoApi: ForgejoApi = {
    findRepo: async ({ baseUrl, user, password, owner, name }) => {
        const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
        const response = await request({ method: "GET", baseUrl, path, user, password });
        if (response.status === 404) {
            return undefined;
        }
        return toRepo(parseResponse(rawRepoSchema, await (await ok(response, "GET", path)).json(), `Forgejo API GET ${path}`));
    },
    createRepo: async ({ baseUrl, user, password, owner, ownerIsOrg, name, private: isPrivate, autoInit }) => {
        const path = ownerIsOrg ? `/orgs/${encodeURIComponent(owner)}/repos` : `/admin/users/${encodeURIComponent(owner)}/repos`;
        const response = await request({ method: "POST", baseUrl, path, user, password, body: { name, private: isPrivate, auto_init: autoInit } });
        return toRepo(parseResponse(rawRepoSchema, await (await ok(response, "POST", path)).json(), `Forgejo API POST ${path}`));
    },
    findUser: async ({ baseUrl, user, password, username }) => {
        const path = `/users/${encodeURIComponent(username)}`;
        const response = await request({ method: "GET", baseUrl, path, user, password });
        if (response.status === 404) {
            return false;
        }
        await ok(response, "GET", path);
        return true;
    },
    createUser: async ({ baseUrl, user, password, username, email, accountPassword }) => {
        const path = "/admin/users";
        const body = { username, email, password: accountPassword, must_change_password: false, visibility: "private" };
        await ok(await request({ method: "POST", baseUrl, path, user, password, body }), "POST", path);
    },
    findOrg: async ({ baseUrl, user, password, org }) => {
        const path = `/orgs/${encodeURIComponent(org)}`;
        const response = await request({ method: "GET", baseUrl, path, user, password });
        if (response.status === 404) {
            return false;
        }
        await ok(response, "GET", path);
        return true;
    },
    createOrg: async ({ baseUrl, user, password, org }) => {
        const path = `/admin/users/${encodeURIComponent(user)}/orgs`;
        await ok(await request({ method: "POST", baseUrl, path, user, password, body: { username: org, visibility: "private" } }), "POST", path);
    },
    findTeam: async ({ baseUrl, user, password, org, name }) => {
        const path = `/orgs/${encodeURIComponent(org)}/teams/${encodeURIComponent(name)}`;
        const response = await request({ method: "GET", baseUrl, path, user, password });
        if (response.status === 404) {
            return undefined;
        }
        const raw = parseResponse(rawTeamSchema, await (await ok(response, "GET", path)).json(), `Forgejo API GET ${path}`);
        return { id: raw.id, permission: raw.permission };
    },
    createTeam: async ({ baseUrl, user, password, org, name, permission }) => {
        const path = `/orgs/${encodeURIComponent(org)}/teams`;
        const body = { name, permission, units: ["repo.code"], includes_all_repositories: false, can_create_org_repo: false };
        const response = await request({ method: "POST", baseUrl, path, user, password, body });
        const raw = parseResponse(rawTeamSchema, await (await ok(response, "POST", path)).json(), `Forgejo API POST ${path}`);
        return { id: raw.id, permission: raw.permission };
    },
    addTeamMember: async ({ baseUrl, user, password, teamId, username }) => {
        const path = `/teams/${teamId}/members/${encodeURIComponent(username)}`;
        await ok(await request({ method: "PUT", baseUrl, path, user, password }), "PUT", path);
    },
    addTeamRepo: async ({ baseUrl, user, password, teamId, org, name }) => {
        const path = `/teams/${teamId}/repos/${encodeURIComponent(org)}/${encodeURIComponent(name)}`;
        await ok(await request({ method: "PUT", baseUrl, path, user, password }), "PUT", path);
    },
    listHooks: async ({ baseUrl, user, password, owner, name }) => {
        const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/hooks`;
        const response = await request({ method: "GET", baseUrl, path, user, password });
        return parseResponse(z.array(forgejoHookSchema), await (await ok(response, "GET", path)).json(), `Forgejo API GET ${path}`);
    },
    createHook: async ({ baseUrl, user, password, owner, name, type, config, events }) => {
        const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/hooks`;
        await ok(await request({ method: "POST", baseUrl, path, user, password, body: { type, config, events, active: true } }), "POST", path);
    },
    updateHook: async ({ baseUrl, user, password, owner, name, id, config, events }) => {
        const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/hooks/${id}`;
        await ok(await request({ method: "PATCH", baseUrl, path, user, password, body: { config, events, active: true } }), "PATCH", path);
    },
    latestCommit: async ({ baseUrl, user, password, owner, name, branch }) => {
        const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/commits?sha=${encodeURIComponent(branch)}&limit=1`;
        const response = await request({ method: "GET", baseUrl, path, user, password });
        // An empty repo answers 409 and a missing branch 404; either way nothing has been pushed yet.
        if (!response.ok) {
            return undefined;
        }
        const commits = parseResponse(z.array(rawCommitSchema), await response.json(), `Forgejo API GET ${path}`);
        return commits[0]?.sha;
    },
    readFile: async ({ baseUrl, user, password, owner, name, branch, path: filePath }) => {
        const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/raw/${encodePath(filePath)}?ref=${encodeURIComponent(branch)}`;
        const response = await request({ method: "GET", baseUrl, path, user, password });
        if (response.status === 404) {
            return undefined;
        }
        return (await ok(response, "GET", path)).text();
    },
    commitFile: async ({ baseUrl, user, password, owner, name, branch, path: filePath, content, message }) => {
        const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/contents/${encodePath(filePath)}`;
        const base64 = Buffer.from(content).toString("base64");
        // Creates with POST, replaces with PUT (needs the current blob sha); look up the file first to choose.
        const existing = await request({ method: "GET", baseUrl, path: `${path}?ref=${encodeURIComponent(branch)}`, user, password });
        if (existing.status === 404) {
            await ok(await request({ method: "POST", baseUrl, path, user, password, body: { content: base64, message, branch } }), "POST", path);
            return;
        }
        const current = parseResponse(rawContentSchema, await (await ok(existing, "GET", path)).json(), `Forgejo API GET ${path}`);
        await ok(
            await request({ method: "PUT", baseUrl, path, user, password, body: { content: base64, message, branch, sha: current.sha } }),
            "PUT",
            path,
        );
    },
    setRepoSecret: async ({ baseUrl, user, password, owner, name, secretName, data }) => {
        const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/actions/secrets/${encodeURIComponent(secretName)}`;
        // PUT is create-or-replace; Forgejo accepts the plaintext value as `data`; 201/204 both ok().
        await ok(await request({ method: "PUT", baseUrl, path, user, password, body: { data } }), "PUT", path);
    },
    deleteRepo: async ({ baseUrl, user, password, owner, name }) => {
        const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}`;
        await okOrMissing(await request({ method: "DELETE", baseUrl, path, user, password }), "DELETE", path);
    },
    deleteFile: async ({ baseUrl, user, password, owner, name, branch, path: filePath, message }) => {
        const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/contents/${encodePath(filePath)}`;
        const existing = await request({ method: "GET", baseUrl, path: `${path}?ref=${encodeURIComponent(branch)}`, user, password });
        if (existing.status === 404) {
            return;
        }
        const current = parseResponse(rawContentSchema, await (await ok(existing, "GET", path)).json(), `Forgejo API GET ${path}`);
        await okOrMissing(
            await request({ method: "DELETE", baseUrl, path, user, password, body: { message, branch, sha: current.sha } }),
            "DELETE",
            path,
        );
    },
    deleteRepoSecret: async ({ baseUrl, user, password, owner, name, secretName }) => {
        const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/actions/secrets/${encodeURIComponent(secretName)}`;
        await okOrMissing(await request({ method: "DELETE", baseUrl, path, user, password }), "DELETE", path);
    },
    deleteHook: async ({ baseUrl, user, password, owner, name, id }) => {
        const path = `/repos/${encodeURIComponent(owner)}/${encodeURIComponent(name)}/hooks/${id}`;
        await okOrMissing(await request({ method: "DELETE", baseUrl, path, user, password }), "DELETE", path);
    },
    deleteUser: async ({ baseUrl, user, password, username }) => {
        const path = `/admin/users/${encodeURIComponent(username)}?purge=true`;
        await okOrMissing(await request({ method: "DELETE", baseUrl, path, user, password }), "DELETE", path);
    },
    deleteOrg: async ({ baseUrl, user, password, org }) => {
        const path = `/orgs/${encodeURIComponent(org)}`;
        await okOrMissing(await request({ method: "DELETE", baseUrl, path, user, password }), "DELETE", path);
    },
    deleteTeam: async ({ baseUrl, user, password, teamId }) => {
        const path = `/teams/${teamId}`;
        await okOrMissing(await request({ method: "DELETE", baseUrl, path, user, password }), "DELETE", path);
    },
};
