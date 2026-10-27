import { readBody, sendJson } from "@intentic/testing/http-fake";
import type { ServerResponse } from "node:http";
import { z } from "zod";
import { httpServer } from "../kit/http.js";
import { smartHttpRepository } from "../kit/smart-http.js";

// Only fields consumed by the probe, publish and documented jq commands belong to this contract.
export const githubResponses = {
    user: z.object({ login: z.string().min(1) }),
    repos: z.array(z.object({ full_name: z.string(), private: z.boolean() })).min(1),
    issues: z.array(z.object({ number: z.number(), title: z.string() })).min(1),
    created: z.object({ clone_url: z.string().url() }),
    refused: z.object({ message: z.string(), documentation_url: z.string().url(), status: z.string() }),
};

export const githubSamples = {
    user: githubResponses.user.parse({ login: "conformance-bot" }),
    repos: githubResponses.repos.parse([{ full_name: "conformance-bot/scratch", private: true }]),
    issues: githubResponses.issues.parse([{ number: 7, title: "Conformance fixture issue" }]),
};

interface KeyUploads {
    keyAttempts: number;
    keyUploads: number;
    allowKeyUploads: boolean;
}

const uploadKey = (response: ServerResponse, body: string, state: KeyUploads): void => {
    state.keyAttempts += 1;
    if (state.allowKeyUploads) {
        state.keyUploads += 1;
        sendJson(response, 201, { id: state.keyUploads, key: z.object({ key: z.string() }).parse(JSON.parse(body)).key });
    } else {
        sendJson(response, 403, {
            message: "Resource not accessible by personal access token",
            documentation_url: "https://docs.github.com/rest/users/keys",
            status: "403",
        });
    }
};

const createRepo = (response: ServerResponse, path: string, body: string): void => {
    const input = z.object({ name: z.string(), private: z.literal(true), auto_init: z.literal(false) }).parse(JSON.parse(body));
    if (input.name === "refused") {
        sendJson(response, 403, {
            message: "Resource not accessible by personal access token",
            documentation_url: "https://docs.github.com/rest/repos/repos",
            status: "403",
        });
    } else {
        const owner = path === "/user/repos" ? githubSamples.user.login : path.split("/")[2];
        sendJson(response, 201, githubResponses.created.parse({ clone_url: `https://github.com/${owner}/${input.name}.git` }));
    }
};

const serveApi = (method: string, path: string, response: ServerResponse, body: string, state: KeyUploads, repo: string): void => {
    if (method === "GET" && path === "/user") {
        sendJson(response, 200, githubSamples.user);
    } else if (method === "GET" && path === "/user/repos") {
        sendJson(response, 200, githubSamples.repos);
    } else if (method === "GET" && /^\/repos\/[^/]+\/[^/]+\/issues$/u.test(path)) {
        sendJson(response, 200, githubSamples.issues);
    } else if (method === "POST" && path === "/user/keys") {
        uploadKey(response, body, state);
    } else if (method === "POST" && (path === "/user/repos" || /^\/orgs\/[^/]+\/repos$/u.test(path))) {
        createRepo(response, path, body);
    } else if (method === "DELETE" && path === `/repos/${repo}`) {
        response.writeHead(204);
        response.end();
    } else {
        sendJson(response, 404, { message: "Not Found", documentation_url: "https://docs.github.com/rest", status: "404" });
    }
};

export const startGithubFake = async (root: string) => {
    const token = "github-conformance-token";
    const repo = githubSamples.repos[0]!.full_name;
    const git = await smartHttpRepository(root, repo);
    const requests: { method: string; path: string; authorization: string; headers: string; body: string }[] = [];
    const state = { keyAttempts: 0, keyUploads: 0, allowKeyUploads: false };
    const server = await httpServer(async (request, response) => {
        const url = new URL(request.url ?? "/", "http://localhost");
        const method = request.method ?? "GET";
        const authorization = request.headers.authorization ?? "";
        const isGit = url.pathname.startsWith(`/${repo}.git/`);
        const body = isGit ? "" : await readBody(request);
        requests.push({ method, path: url.pathname, authorization, headers: JSON.stringify(request.headers), body });
        const expected = isGit ? `Basic ${Buffer.from(`x-access-token:${token}`).toString("base64")}` : `Bearer ${token}`;
        if (authorization !== expected) {
            if (isGit) {
                response.writeHead(401, { "www-authenticate": 'Basic realm="GitHub"' });
                response.end("Repository not found.");
            } else {
                sendJson(
                    response,
                    401,
                    githubResponses.refused.parse({ message: "Bad credentials", documentation_url: "https://docs.github.com/rest", status: "401" }),
                );
            }
            return;
        }
        if (isGit) {
            await git.serve(request, response);
        } else {
            serveApi(method, url.pathname, response, body, state, repo);
        }
    });
    return { ...server, token, repo, login: githubSamples.user.login, requests, state, bare: git.bare };
};

export type GithubFake = Awaited<ReturnType<typeof startGithubFake>>;
