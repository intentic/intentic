import { errnoCode, undefinedIfMissing } from "@intentic/base/errors";
import { webStream } from "@intentic/base/web-stream";
import { lstat, open, type FileHandle } from "node:fs/promises";
import { constants } from "node:fs";
import { join } from "node:path";
import { producedDocumentPaths } from "@intentic/sandbox-contract/text/documents";
import { defaultGit } from "@intentic/base/git";
import type { Context } from "hono";
import type { AppEnv } from "../app-env.js";
import type { Services } from "../composition.js";
import type { PersistedAgent, IsolatedAgent, RepoRecord } from "./registry/agents-store.js";
import { provenanceOf, refuseUnlessVisible } from "../auth/fleet-scope.js";
import { resolveWorkspacePath } from "../workspace/files/workspace-files-paths.js";
import { contentTypeForPath } from "../workspace/files/workspace-files-download.js";

// A conversation's results as bytes: the documents its own calls recorded writing (producedDocumentPaths, the same
// record the chat's document chips are drawn from), readable by whoever may see the conversation, a guest included,
// who has no Files to open them in. The record is the whole authorization: a path a call never wrote, a path that
// climbs, and any link on the way are refused. Read from the conversation's own checkout until its work is accepted,
// and from the main tree once a land into it carried the file, which is what keeps it readable after the checkout goes.

// No normalization here: a record never authorizes aliases, traversal, or any link on the way to a result.
export const producedFileAt = async (root: string, path: string): Promise<string | undefined> => {
    const parts = path.split("/");
    if (parts.some((part) => part === "" || part === "." || part === ".." || part.includes("\\") || part.includes("\0"))) {
        return undefined;
    }
    let target = root;
    for (const part of parts) {
        target = join(target, part);
        // A link is never followed, even one that stays within the tree.
        const entry = await lstat(target).catch(undefinedIfMissing);
        if (entry === undefined || entry.isSymbolicLink()) {
            return undefined;
        }
    }
    const resolved = await resolveWorkspacePath(root, path);
    return resolved.kind === "inside" && (await lstat(target)).isFile() ? target : undefined;
};

// Opens each segment relative to the directory already open, so a rename between the checks above and the read cannot
// swap an ancestor for a link. /proc/self/fd is this process's own handle namespace, not a caller-supplied path.
const openResultWithin = async (root: string, path: string): Promise<FileHandle | undefined> => {
    if ((await producedFileAt(root, path)) === undefined) {
        return undefined;
    }
    let directory: FileHandle | undefined = await open(root, constants.O_RDONLY | constants.O_DIRECTORY);
    try {
        const parts = path.split("/");
        for (const [index, part] of parts.entries()) {
            const last = index === parts.length - 1;
            const next = await open(`/proc/self/fd/${directory.fd}/${part}`, constants.O_RDONLY | constants.O_NOFOLLOW | (last ? 0 : constants.O_DIRECTORY));
            await directory.close();
            if (last) {
                directory = undefined;
                return next;
            }
            directory = next;
        }
        return undefined;
    } finally {
        await directory?.close();
    }
};

// The repo of a checkout a workspace path falls in: the deepest nested one that holds it, else the root.
const repoHolding = (repos: readonly RepoRecord[], path: string): RepoRecord | undefined =>
    repos.toSorted((a, b) => b.repo.length - a.repo.length).find(({ repo }) => repo === "root" || path.startsWith(`${repo}/`));

const succeeds = (dir: string, args: readonly string[]): Promise<boolean> => defaultGit(dir, [...args]).then(
    () => true,
    () => false,
);

// Where to read a result, in order. A conversation on the shared tree has nothing else. One on a checkout of its own
// reads that checkout alone until a land into the main tree carried this file (its landed tip holds it; a land into a
// parent's checkout is not one): the main tree then holds the accepted copy, read first while the checkout's own is
// unchanged since, and the only one left once the checkout is gone. A file the checkout lacks is never looked up in
// the main tree before that, where a same-named file may be anyone's.
const placesOf = async (services: Pick<Services, "workspaceScope">, entry: PersistedAgent, path: string): Promise<string[]> => {
    const { main } = services.workspaceScope;
    if (entry.placement.kind !== "worktree") {
        return [main];
    }
    const checkout = services.workspaceScope.worktreeDir(entry.id);
    const composed = repoHolding(entry.placement.repos, path);
    if (composed?.landedTip === undefined || entry.placement.landedInto !== undefined) {
        return [checkout];
    }
    const nested = composed.repo === "root" ? "" : composed.repo;
    const relative = nested === "" ? path : path.slice(nested.length + 1);
    if (!(await succeeds(join(main, nested), ["cat-file", "-e", `${composed.landedTip}:${relative}`]))) {
        return [checkout];
    }
    const unchanged = await succeeds(join(checkout, nested), ["diff", "--quiet", composed.landedTip, "--", relative]);
    return unchanged ? [main, checkout] : [checkout, main];
};

export const documentsOf = async (services: Pick<Services, "transcripts">, entry: PersistedAgent): Promise<string[]> =>
    producedDocumentPaths(await services.transcripts.read(entry));

// Why this caller may not have this conversation's files, or undefined when it may.
const refusalFor = (caller: AppEnv["Variables"]["identity"], entry: PersistedAgent): string | undefined => {
    try {
        refuseUnlessVisible(caller, provenanceOf(entry));
    } catch {
        return "not your conversation";
    }
    // A guest's reach is narrower than its view: once a conversation is handed to someone else, the guest who started
    // it no longer takes its files away.
    const owner = entry.social.owner?.email ?? entry.identity.startedBy;
    const theirs = owner?.toLowerCase() === caller?.email.toLowerCase();
    return caller?.role === "guest" && !theirs ? "not your conversation" : undefined;
};

// The file at `path` under the first of `roots` that holds it, open; "refused" when the path meets a link or a file
// where a folder should be on the way.
const openFirst = async (roots: readonly string[], path: string): Promise<FileHandle | "refused" | undefined> => {
    for (const root of roots) {
        try {
            const file = await openResultWithin(root, path);
            if (file !== undefined) {
                return file;
            }
        } catch (cause) {
            const code = errnoCode(cause);
            if (code === "ELOOP" || code === "ENOTDIR") {
                return "refused";
            }
            if (code !== "ENOENT") {
                throw cause;
            }
        }
    }
    return undefined;
};

export const createProducedFileRoute =
    (services: Pick<Services, "agents" | "transcripts" | "workspaceScope">) =>
    async (c: Context<AppEnv>): Promise<Response> => {
        const entry = services.agents.entry(c.req.param("id") ?? "");
        const path = c.req.query("path");
        if (entry === undefined || path === undefined) {
            return c.json({ error: "not found" }, 404);
        }
        const refusal = refusalFor(c.get("identity"), entry);
        if (refusal !== undefined) {
            return c.json({ error: refusal }, 403);
        }
        if (!(await documentsOf(services, entry)).includes(path)) {
            return c.json({ error: "not a recorded result" }, 403);
        }
        const file = await openFirst(await placesOf(services, entry, path), path);
        if (file === "refused") {
            return c.json({ error: "invalid result path" }, 403);
        }
        const info = await file?.stat();
        if (file === undefined || info?.isFile() !== true) {
            await file?.close();
            return c.json({ error: "not found" }, 404);
        }
        // The handle pins the bytes through the response; no second open by path after the checks.
        return new Response(webStream(file.readableWebStream({ autoClose: true })), {
            headers: {
                "Content-Type": contentTypeForPath(path),
                "Content-Length": String(info.size),
                "Cache-Control": "private, no-store",
                "Content-Disposition": `attachment; filename*=UTF-8''${encodeURIComponent(path.split("/").at(-1) ?? "document")}`,
            },
        });
    };

// Called inside the land's lease, before its capture: each recorded result the checkout holds is staged by force, so a
// document git ignores, or one the land would set aside as scratch, rides the press like any other file. Only the
// recorded ones, each at its own path: an unrelated ignored file stays where it was.
export const includeProducedFiles = async (services: Pick<Services, "transcripts" | "agentWorktrees">, entry: IsolatedAgent): Promise<void> => {
    const paths = await documentsOf(services, entry);
    for (const { repo } of entry.placement.repos) {
        const root = services.agentWorktrees.worktreeDir(entry.id, repo);
        const nested = entry.placement.repos.map((item) => item.repo).filter((name) => name !== "root" && name !== repo && (repo === "root" || name.startsWith(`${repo}/`)));
        const named = paths
            .filter((path) => !nested.some((name) => path.startsWith(`${name}/`)))
            .flatMap((path) => (repo === "root" ? [path] : path.startsWith(`${repo}/`) ? [path.slice(repo.length + 1)] : []));
        const safe = (await Promise.all(named.map(async (path) => ((await producedFileAt(root, path)) === undefined ? undefined : path)))).filter(
            (path): path is string => path !== undefined,
        );
        if (safe.length > 0) {
            await defaultGit(root, ["add", "--force", "--", ...safe]);
        }
    }
};
