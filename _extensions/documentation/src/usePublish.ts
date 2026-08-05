import { useQueryClient } from "@tanstack/vue-query";
import { GitStatusSchema } from "@intentic/sandbox-contract";
import { refreshDocumentPresence } from "./docPresence.js";
import { host } from "./host.js";
import { publishedTail, stagingDir, stagingPath } from "./paths.js";
import { listStagedTails } from "./stagedTree.js";

/* PUBLISH — the staged set becomes part of the repository, in one commit the owner asked for.
 *
 * This is the step that makes the whole design work: an agent writes documents where they are cheap to inspect and
 * throw away, and only a human decision moves them into the repo's history. It is deliberately not automatic.
 *
 * The mechanics are the daemon's own intended flow. `POST /git/{repo}/commit` has two shapes and no path-scoped
 * variant — with `all` it stages everything first, without it the index is recorded as it stands — and the routes'
 * own comment says why: "staging is how the user chooses". So publish writes the files, stages exactly its own
 * paths, and commits WITHOUT `all`. `all` would sweep every unrelated edit in the repo into a docs commit, which
 * in a workspace with live agents in it is a real way to lose someone else's work — and more so now that a
 * published path is a README beside somebody's working tree rather than a quiet corner of `docs/`.
 *
 * A LIMIT WORTH KNOWING, because it is not fixable from here. If something was ALREADY staged in this repo before
 * publishing, it rides along in the commit — a bare commit records the whole index, not just the paths we added.
 * The daemon's status route cannot distinguish that case: `GitStatus.files` carries porcelain lines that
 * `_sandbox/scaffold/src/git.ts` has already `.trim()`ed, and trimming is exactly what destroys the leading column
 * that says "staged". So `preflight()` reports every change that is not one of the paths this publish will
 * write, and the UI names the number before the owner commits, rather than pretending to a precision the wire
 * does not carry. A staged-paths
 * read on the daemon would remove the caveat; inventing one here would only hide it. */

// The daemon's git routes address the workspace's own root repo as "root"; every other repo is its root-relative
// dir. Repo-relative paths inside the commit are unaffected.
const gitRepo = (repo: string): string => (repo === `` ? `root` : repo);

export interface Preflight {
    readonly tails: readonly string[];
    // Changed paths in this repo that are NOT part of the document set — what may ride along. See the header.
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
            /* A porcelain line is "<XY> <path>"; only the path matters for this test, and it is whatever follows
             * the last space-run in the status columns.
             *
             * "Foreign" is decided against the paths THIS publish will write, not against a directory prefix.
             * It has to be: a package's page is its own README, so the set no longer lives under one root, and a
             * prefix test would report every page it is about to publish as somebody else's change. */
            const mine = new Set(tails.map((tail) => publishedTail(tail)));
            foreign = status.files.map((line) => line.replace(/^\S+\s+/, ``)).filter((path) => !mine.has(path));
        } catch {
            // Not a git repo, or no HEAD yet. Publishing will fail loudly at the commit; there is nothing useful to
            // warn about in advance.
        }
        return { tails, foreign, branch };
    };

    /* Write → stage → commit → drop the draft. The draft is deleted last and only on success, so a failed publish
     * leaves the staged set exactly where it was and the owner can retry. */
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
                message: `docs: publish architecture documentation\n\n${paths.length} file${paths.length === 1 ? `` : `s`} — package READMEs and the repository map.`,
            }),
        });
        await api.sandbox.request(`/workspace/entry`, {
            method: `DELETE`,
            headers: { "content-type": `application/json` },
            body: JSON.stringify({ path: stagingDir(repo) }),
        });
        void queryClient.invalidateQueries({ queryKey: api.sandbox.key(`documentation`) });
        // The tree's icons are module state on a slow poll, not a query — invalidation cannot reach them, and a
        // publish is precisely when a draft icon becomes a published one.
        refreshDocumentPresence();
    };

    const discard = async (repo: string): Promise<void> => {
        await api.sandbox.request(`/workspace/entry`, {
            method: `DELETE`,
            headers: { "content-type": `application/json` },
            body: JSON.stringify({ path: stagingDir(repo) }),
        });
        void queryClient.invalidateQueries({ queryKey: api.sandbox.key(`documentation`) });
        // The tree's icons are module state on a slow poll, not a query — invalidation cannot reach them, and a
        // publish is precisely when a draft icon becomes a published one.
        refreshDocumentPresence();
    };

    return { preflight, publish, discard };
}
