import { z } from "zod";
import { parseResponse } from "../core/inputs.js";

// Thin wrapper over the GitLab REST API v4. Each function takes the instance url + token + the minimum inputs
// and returns only the fields the providers consume. Like github-api.ts / forgejo-api.ts: pure HTTP, no state,
// injectable for tests. GitLab is self-hostable, so the base url is per-call (not a module constant like GitHub).

const headers = (token: string): Record<string, string> => ({ "PRIVATE-TOKEN": token });

const base = (url: string): string => `${url.replace(/\/+$/, "")}/api/v4`;

// A project is addressed by its URL-encoded "owner/name" path everywhere the API takes an :id.
const projectPath = (owner: string, name: string): string => encodeURIComponent(`${owner}/${name}`);

const json = async (url: string, init: RequestInit): Promise<unknown> => {
    // Timeout bounds a stalled connection (undici's default headers timeout is ~5 minutes).
    const response = await fetch(url, { ...init, signal: AbortSignal.timeout(30_000) });
    if (!response.ok) {
        const body = await response.text().catch(() => "");
        throw new Error(`GitLab API ${init.method ?? "GET"} ${url}: ${response.status} ${body}`);
    }
    if (response.status === 204) {
        return undefined;
    }
    return response.json();
};

// --- Schemas for the fields we consume ---

const userSchema = z.object({ username: z.string() });
const projectSchema = z.object({ http_url_to_repo: z.string(), ssh_url_to_repo: z.string() });
const namespaceSchema = z.object({ id: z.number() });
const fileSchema = z.object({ content: z.string() });

// --- Operations ---

export interface GitLabApi {
    getAuthenticatedUser(params: { url: string; token: string }): Promise<{ username: string }>;
    findProject(params: {
        url: string;
        token: string;
        owner: string;
        name: string;
    }): Promise<{ httpUrlToRepo: string; sshUrlToRepo: string } | undefined>;
    createProject(params: { url: string; token: string; owner: string; name: string; private: boolean; ownerIsGroup: boolean }): Promise<void>;
    deleteProject(params: { url: string; token: string; owner: string; name: string }): Promise<void>;
    readFile(params: {
        url: string;
        token: string;
        owner: string;
        name: string;
        path: string;
        branch: string;
    }): Promise<{ content: string } | undefined>;
    commitFile(params: {
        url: string;
        token: string;
        owner: string;
        name: string;
        path: string;
        content: string;
        branch: string;
        message: string;
    }): Promise<void>;
    deleteFile(params: { url: string; token: string; owner: string; name: string; path: string; branch: string; message: string }): Promise<void>;
    setCiVariable(params: { url: string; token: string; owner: string; name: string; key: string; value: string }): Promise<void>;
    deleteCiVariable(params: { url: string; token: string; owner: string; name: string; key: string }): Promise<void>;
}

export const gitlabApi: GitLabApi = {
    getAuthenticatedUser: async ({ url, token }) => {
        const data = await json(`${base(url)}/user`, { headers: headers(token) });
        return parseResponse(userSchema, data, "GitLab /user");
    },

    findProject: async ({ url, token, owner, name }) => {
        const response = await fetch(`${base(url)}/projects/${projectPath(owner, name)}`, {
            headers: headers(token),
            signal: AbortSignal.timeout(30_000),
        });
        if (response.status === 404) {
            return undefined;
        }
        if (!response.ok) {
            throw new Error(`GitLab API GET /projects/${owner}/${name}: ${response.status}`);
        }
        const data = parseResponse(projectSchema, await response.json(), "GitLab /projects");
        return { httpUrlToRepo: data.http_url_to_repo, sshUrlToRepo: data.ssh_url_to_repo };
    },

    createProject: async ({ url, token, owner, name, private: isPrivate, ownerIsGroup }) => {
        const body: Record<string, unknown> = {
            name,
            path: name,
            visibility: isPrivate ? "private" : "public",
            initialize_with_readme: true,
        };
        // Under a group: resolve its numeric namespace id (POST /projects without one creates under the user).
        if (ownerIsGroup) {
            const ns = await json(`${base(url)}/namespaces/${encodeURIComponent(owner)}`, { headers: headers(token) });
            body["namespace_id"] = parseResponse(namespaceSchema, ns, "GitLab /namespaces").id;
        }
        await json(`${base(url)}/projects`, {
            method: "POST",
            headers: { ...headers(token), "Content-Type": "application/json" },
            body: JSON.stringify(body),
        });
    },

    deleteProject: async ({ url, token, owner, name }) => {
        const response = await fetch(`${base(url)}/projects/${projectPath(owner, name)}`, {
            method: "DELETE",
            headers: headers(token),
            signal: AbortSignal.timeout(30_000),
        });
        if (response.status === 404) {
            return;
        }
        if (!response.ok) {
            throw new Error(`GitLab API DELETE /projects/${owner}/${name}: ${response.status}`);
        }
    },

    readFile: async ({ url, token, owner, name, path, branch }) => {
        const endpoint = `${base(url)}/projects/${projectPath(owner, name)}/repository/files/${encodeURIComponent(path)}?ref=${encodeURIComponent(branch)}`;
        const response = await fetch(endpoint, { headers: headers(token), signal: AbortSignal.timeout(30_000) });
        if (response.status === 404) {
            return undefined;
        }
        if (!response.ok) {
            throw new Error(`GitLab API GET file ${path}: ${response.status}`);
        }
        const data = parseResponse(fileSchema, await response.json(), "GitLab /repository/files");
        return { content: Buffer.from(data.content, "base64").toString("utf-8") };
    },

    commitFile: async ({ url, token, owner, name, path, content, branch, message }) => {
        // GitLab splits create/update by verb (POST=create, PUT=update, like Forgejo) rather than passing a
        // sha, so probe existence first to pick the verb.
        const exists = (await gitlabApi.readFile({ url, token, owner, name, path, branch })) !== undefined;
        const endpoint = `${base(url)}/projects/${projectPath(owner, name)}/repository/files/${encodeURIComponent(path)}`;
        await json(endpoint, {
            method: exists ? "PUT" : "POST",
            headers: { ...headers(token), "Content-Type": "application/json" },
            body: JSON.stringify({ branch, content: Buffer.from(content).toString("base64"), encoding: "base64", commit_message: message }),
        });
    },

    deleteFile: async ({ url, token, owner, name, path, branch, message }) => {
        const endpoint = `${base(url)}/projects/${projectPath(owner, name)}/repository/files/${encodeURIComponent(path)}`;
        const response = await fetch(endpoint, {
            method: "DELETE",
            headers: { ...headers(token), "Content-Type": "application/json" },
            body: JSON.stringify({ branch, commit_message: message }),
            signal: AbortSignal.timeout(30_000),
        });
        if (response.status === 404) {
            return;
        }
        if (!response.ok) {
            throw new Error(`GitLab API DELETE file ${path}: ${response.status}`);
        }
    },

    setCiVariable: async ({ url, token, owner, name, key, value }) => {
        // Plaintext project CI/CD variables — no sealed-box encryption (the big simplification vs GitHub Actions
        // secrets). Same POST=create / PUT=update split as files. protected:false so all branches see it;
        // masked:false because multi-line values (SSH keys) fail GitLab's masking constraints.
        const varsBase = `${base(url)}/projects/${projectPath(owner, name)}/variables`;
        const probe = await fetch(`${varsBase}/${encodeURIComponent(key)}`, { headers: headers(token), signal: AbortSignal.timeout(30_000) });
        if (!probe.ok && probe.status !== 404) {
            throw new Error(`GitLab API GET variable ${key}: ${probe.status}`);
        }
        const exists = probe.status !== 404;
        await json(exists ? `${varsBase}/${encodeURIComponent(key)}` : varsBase, {
            method: exists ? "PUT" : "POST",
            headers: { ...headers(token), "Content-Type": "application/json" },
            body: JSON.stringify({ key, value, protected: false, masked: false }),
        });
    },

    deleteCiVariable: async ({ url, token, owner, name, key }) => {
        const response = await fetch(`${base(url)}/projects/${projectPath(owner, name)}/variables/${encodeURIComponent(key)}`, {
            method: "DELETE",
            headers: headers(token),
            signal: AbortSignal.timeout(30_000),
        });
        if (response.status === 404) {
            return;
        }
        if (!response.ok) {
            throw new Error(`GitLab API DELETE variable ${key}: ${response.status}`);
        }
    },
};
