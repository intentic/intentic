import { useQueryClient } from "@tanstack/vue-query";
import { GitStatusSchema } from "@intentic/sandbox-contract";
import { refreshDocumentPresence } from "./docPresence.js";
import { host } from "./host.js";
import { publishedTail, stagingDir, stagingPath } from "./paths.js";
import { listStagedTails } from "./stagedTree.js";

// Turns a staged set into one commit the owner asked for; deliberately not automatic. Commits without `all`, staging
// only its own paths, so unrelated edits in a live workspace aren't swept in. Anything already staged before publishing
// still rides along; preflight reports it as `foreign` rather than hiding the gap.

// The daemon's git routes address the workspace root as "root"; every other repo is its root-relative dir.
const gitRepo = (repo: string): string => (repo === `` ? `root` : repo);

export interface Preflight {
    readonly tails: readonly string[];
    // Changed paths in this repo that are not part of the document set; what may ride along with the commit.
    readonly foreign: readonly string[];
    readonly branch: string;
}

export function usePublish() {
    const api = host();
    const queryClient = useQueryClient();

    const readStaged = async (repo: string, tail: string): Promise<string | undefined> => await api.workspace.file(stagingPath(repo, tail));

    const preflight = async (repo: string): Promise<Preflight> => {
        const tails = await listStagedTails(api, repo);
        let branch = ``;
        let foreign: readonly string[] = [];
        try {
            const status = GitStatusSchema.parse(await api.sandbox.json(`/git/${encodeURIComponent(gitRepo(repo))}/status`));
            branch = status.branch;
            // Only the path after the porcelain status columns matters. "Foreign" compares against the exact paths this
            // publish writes, not a directory prefix, since a package's README no longer lives under one root.
            const mine = new Set(tails.map((tail) => publishedTail(tail)));
            foreign = status.files.map((line) => line.replace(/^\S+\s+/, ``)).filter((path) => !mine.has(path));
        } catch {
            // Not a git repo, or no HEAD yet; publishing will fail loudly at the commit, nothing to warn about here.
        }
        return { tails, foreign, branch };
    };

    // Write, stage, commit, then drop the draft, deleted last and only on success, so a failed publish leaves the
    // staged set retryable.
    const publish = async (repo: string, tails: readonly string[]): Promise<void> => {
        const paths: string[] = [];
        for (const tail of tails) {
            const content = await readStaged(repo, tail);
            if (content === undefined) {
                continue;
            }
            const path = publishedTail(tail);
            await api.sandbox.request(`/git/${encodeURIComponent(gitRepo(repo))}/file`, {
                method: `PUT`,
                headers: { "content-type": `application/json` },
                body: JSON.stringify({ repo: gitRepo(repo), path, content }),
            });
            paths.push(path);
        }
        if (paths.length === 0) {
            return;
        }
        await api.sandbox.request(`/git/${encodeURIComponent(gitRepo(repo))}/stage`, {
            method: `POST`,
            headers: { "content-type": `application/json` },
            body: JSON.stringify({ repo: gitRepo(repo), paths }),
        });
        await api.sandbox.request(`/git/${encodeURIComponent(gitRepo(repo))}/commit`, {
            method: `POST`,
            headers: { "content-type": `application/json` },
            body: JSON.stringify({
                repo: gitRepo(repo),
                message: `docs: publish architecture documentation\n\n${paths.length} file${paths.length === 1 ? `` : `s`}, package READMEs and the repository map.`,
            }),
        });
        await api.sandbox.request(`/workspace/entry`, {
            method: `DELETE`,
            headers: { "content-type": `application/json` },
            body: JSON.stringify({ path: stagingDir(repo) }),
        });
        void queryClient.invalidateQueries({ queryKey: api.sandbox.key(`documentation`) });
        // Tree icons are module state on a slow poll, not a query; invalidation can't reach them, so refresh directly.
        refreshDocumentPresence();
    };

    const discard = async (repo: string): Promise<void> => {
        await api.sandbox.request(`/workspace/entry`, {
            method: `DELETE`,
            headers: { "content-type": `application/json` },
            body: JSON.stringify({ path: stagingDir(repo) }),
        });
        void queryClient.invalidateQueries({ queryKey: api.sandbox.key(`documentation`) });
        // Tree icons are module state on a slow poll, not a query; invalidation can't reach them, so refresh directly.
        refreshDocumentPresence();
    };

    return { preflight, publish, discard };
}
