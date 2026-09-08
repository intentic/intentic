import { z } from "zod";
import { parseResponse } from "../core/inputs.js";
import { restClient } from "../core/rest-client.js";

// Thin wrapper over the GitHub REST API: each function takes a token + minimal inputs, returns only the fields
// consumed. Pure HTTP, no state, injectable for tests.

const headers = (token: string): Record<string, string> => ({
    Authorization: `Bearer ${token}`,
    Accept: "application/vnd.github+json",
    "X-GitHub-Api-Version": "2022-11-28",
});

// --- Schemas for the fields we consume ---

const userSchema = z.object({ login: z.string() });
const repoSchema = z.object({ clone_url: z.string(), ssh_url: z.string(), full_name: z.string() });
const publicKeySchema = z.object({ key_id: z.string(), key: z.string() });
const contentSchema = z.object({ content: z.string(), sha: z.string() });

// --- Operations ---

export interface GitHubApi {
    getAuthenticatedUser(params: { token: string }): Promise<{ login: string }>;
    findRepo(params: { token: string; owner: string; name: string }): Promise<{ cloneUrl: string; sshUrl: string } | undefined>;
    createRepo(params: { token: string; owner: string; name: string; private: boolean; ownerIsOrg: boolean }): Promise<void>;
    deleteRepo(params: { token: string; owner: string; name: string }): Promise<void>;
    readFile(params: {
        token: string;
        owner: string;
        repo: string;
        path: string;
        branch: string;
    }): Promise<{ content: string; sha: string } | undefined>;
    commitFile(params: {
        token: string;
        owner: string;
        repo: string;
        path: string;
        content: string;
        branch: string;
        message: string;
        sha?: string;
    }): Promise<void>;
    deleteFile(params: { token: string; owner: string; repo: string; path: string; branch: string; message: string }): Promise<void>;
    setRepoSecret(params: { token: string; owner: string; repo: string; secretName: string; value: string }): Promise<void>;
    deleteRepoSecret(params: { token: string; owner: string; repo: string; secretName: string }): Promise<void>;
}

const BASE = "https://api.github.com";

const { json, maybe } = restClient("GitHub");

export const githubApi: GitHubApi = {
    getAuthenticatedUser: async ({ token }) => {
        const data = await json(`${BASE}/user`, { headers: headers(token) });
        return parseResponse(userSchema, data, "GitHub /user");
    },

    findRepo: async ({ token, owner, name }) => {
        const response = await maybe(`${BASE}/repos/${owner}/${name}`, { headers: headers(token) });
        if (response === undefined) {
            return undefined;
        }
        const data = parseResponse(repoSchema, await response.json(), "GitHub /repos");
        return { cloneUrl: data.clone_url, sshUrl: data.ssh_url };
    },

    createRepo: async ({ token, owner, name, private: isPrivate, ownerIsOrg }) => {
        const url = ownerIsOrg ? `${BASE}/orgs/${owner}/repos` : `${BASE}/user/repos`;
        await json(url, {
            method: "POST",
            headers: { ...headers(token), "Content-Type": "application/json" },
            body: JSON.stringify({ name, private: isPrivate, auto_init: true }),
        });
    },

    // Already gone is the outcome asked for, so a 404 is success rather than a failure to report.
    deleteRepo: async ({ token, owner, name }) => {
        await maybe(`${BASE}/repos/${owner}/${name}`, { method: "DELETE", headers: headers(token) });
    },

    readFile: async ({ token, owner, repo, path, branch }) => {
        const response = await maybe(`${BASE}/repos/${owner}/${repo}/contents/${path}?ref=${branch}`, { headers: headers(token) });
        if (response === undefined) {
            return undefined;
        }
        const data = parseResponse(contentSchema, await response.json(), "GitHub /contents");
        return { content: Buffer.from(data.content, "base64").toString("utf8"), sha: data.sha };
    },

    commitFile: async ({ token, owner, repo, path, content, branch, message, sha }) => {
        await json(`${BASE}/repos/${owner}/${repo}/contents/${path}`, {
            method: "PUT",
            headers: { ...headers(token), "Content-Type": "application/json" },
            body: JSON.stringify({
                message,
                content: Buffer.from(content).toString("base64"),
                branch,
                ...(sha !== undefined ? { sha } : {}),
            }),
        });
    },

    deleteFile: async ({ token, owner, repo, path, branch, message }) => {
        // Need the sha to delete.
        const file = await githubApi.readFile({ token, owner, repo, path, branch });
        if (file === undefined) {
            return;
        }
        await json(`${BASE}/repos/${owner}/${repo}/contents/${path}`, {
            method: "DELETE",
            headers: { ...headers(token), "Content-Type": "application/json" },
            body: JSON.stringify({ message, sha: file.sha, branch }),
        });
    },

    setRepoSecret: async ({ token, owner, repo, secretName, value }) => {
        // GitHub Actions secrets require libsodium sealed-box encryption against the repo's fetched public key.
        const keyData = await json(`${BASE}/repos/${owner}/${repo}/actions/secrets/public-key`, { headers: headers(token) });
        const parsed = parseResponse(publicKeySchema, keyData, "GitHub /actions/secrets/public-key");

        // Dynamic import of libsodium-wrappers (optional peer dep). The eslint-disable is intentional:
        // Runtime-optional dependency; may not have type declarations installed.
        // eslint-disable-next-line @typescript-eslint/no-unsafe-assignment
        // oxlint-disable-next-line typescript/no-explicit-any -- the module has no types (see core/libsodium-wrappers.d.ts); the `any` is the library, not a shortcut.
        const sodium: any = await import(/* webpackIgnore: true */ "libsodium-wrappers").then(
            // oxlint-disable-next-line typescript/no-explicit-any -- same untyped module as the line above.
            (m: any) => m.default ?? m,
            () => {
                throw new Error("libsodium-wrappers is required for GitHub Actions secrets; install it: pnpm add libsodium-wrappers");
            },
        );
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
        await sodium.ready;

        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
        const keyBytes = sodium.from_base64(parsed.key, sodium.base64_variants.ORIGINAL) as Uint8Array;
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
        const encrypted = sodium.crypto_box_seal(Buffer.from(value), keyBytes) as Uint8Array;
        // eslint-disable-next-line @typescript-eslint/no-unsafe-member-access, @typescript-eslint/no-unsafe-call
        const encryptedBase64 = sodium.to_base64(encrypted, sodium.base64_variants.ORIGINAL) as string;

        await json(`${BASE}/repos/${owner}/${repo}/actions/secrets/${secretName}`, {
            method: "PUT",
            headers: { ...headers(token), "Content-Type": "application/json" },
            body: JSON.stringify({ encrypted_value: encryptedBase64, key_id: parsed.key_id }),
        });
    },

    deleteRepoSecret: async ({ token, owner, repo, secretName }) => {
        await maybe(`${BASE}/repos/${owner}/${repo}/actions/secrets/${secretName}`, { method: "DELETE", headers: headers(token) });
    },
};
