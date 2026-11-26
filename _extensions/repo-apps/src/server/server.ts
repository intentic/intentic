import { stat } from "node:fs/promises";
import { join } from "node:path";
import { undefinedIfMissing } from "@intentic/base/errors";
import type { ExtensionCaller, ExtensionServerApi, ServerActivation } from "@intentic/extension-api";
import type { PackageModules, WorkspaceGraph } from "@intentic/sandbox-contract/schemas/workspace/workspace-graph";
import { GRAPH_ROUTE, isRepoId, LAYERS_ROUTE } from "../backendRoutes.js";
import { readPackageModules } from "./package-modules.js";
import { readUsedPackageGraph } from "./package-usage.js";
import { readWorkspaceManifests } from "./workspace-packages.js";

// The backend: the two reads the Dependencies view draws, a repository's package graph and one package's layers, read
// straight from the workspace through `api.workspaceRoot`. It reaches no daemon route, so the manifest declares no
// `permissions.daemon`. Runs inside the daemon's extension host with node builtins and what it bundles.
// (2026-11-26) Each read answers only a repository its caller may see: a member fenced to areas reads the repositories
// inside them, as the daemon's own routes held them (`api.caller`, the person the daemon verified for the request).

// What a read answers: its shape from the wire contract, or why there is none.
type Answer = WorkspaceGraph | PackageModules | { readonly error: string };

const json = (status: number, body: Answer): Response =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });

// The repository's directory, or the answer that refuses the id: one that could name something outside the workspace,
// or a folder that is not there.
const repoDirOf = async (workspaceRoot: string, repo: string): Promise<string | Response> => {
    if (!isRepoId(repo)) {
        return json(400, { error: "missing or invalid repo" });
    }
    const dir = join(workspaceRoot, repo);
    const found = await stat(dir).catch(undefinedIfMissing);
    return found?.isDirectory() === true ? dir : json(404, { error: `no repository named "${repo}"` });
};

// The refusal for a repository outside the caller's areas, naming the folders they do hold, as the daemon's fence says
// it; or for a request the daemon vouched for nobody on, which no daemon of this extension's engines sends.
const fenced = (caller: ExtensionCaller | undefined, repo: string): Response | undefined => {
    if (caller === undefined) {
        return json(401, { error: "the sandbox did not say who is asking" });
    }
    if (caller.reaches(repo)) {
        return undefined;
    }
    const folders = caller.folders ?? [];
    return json(403, {
        error: folders.length === 0 ? "your access to this workspace holds no folders; ask the owner for an area" : `outside your access to this workspace, which holds ${folders.join(", ")}`,
    });
};

const answer = async (workspaceRoot: string, route: string, query: URLSearchParams, caller: ExtensionCaller | undefined): Promise<Response> => {
    const repo = query.get("repo") ?? "";
    // Refused before the folder is looked at, so a fenced reader learns nothing of what lies outside their areas.
    const outside = isRepoId(repo) ? fenced(caller, repo) : undefined;
    if (outside !== undefined) {
        return outside;
    }
    const repoDir = await repoDirOf(workspaceRoot, repo);
    if (repoDir instanceof Response) {
        return repoDir;
    }
    if (route === GRAPH_ROUTE) {
        return json(200, await readUsedPackageGraph(repoDir));
    }
    const name = query.get("package") ?? "";
    if (name === "") {
        return json(400, { error: "name the package: ?package=<the name it declares>" });
    }
    const modules = await readPackageModules(repoDir, await readWorkspaceManifests(repoDir), name);
    return modules === undefined ? json(404, { error: `no workspace package "${name}" in ${repo}` }) : json(200, modules);
};

export const activateServer = (api: ExtensionServerApi): ServerActivation => {
    api.routes.mount(async (request) => {
        const url = new URL(request.url);
        const route = url.pathname.replace(/^\/+/u, "");
        if (request.method !== "GET" || (route !== GRAPH_ROUTE && route !== LAYERS_ROUTE)) {
            return undefined;
        }
        return await answer(api.workspaceRoot, route, url.searchParams, api.caller(request));
    });
    // Nothing to release: the reads hold no listener, timer or process. Handing one back lets a change to this extension
    // alone reload it in place rather than restart every backend.
    return { deactivate: () => undefined };
};
