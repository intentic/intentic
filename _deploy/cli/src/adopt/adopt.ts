import type { ForgejoApi } from "@intentic/providers";
import { forgejoApi } from "@intentic/providers";
import { defaultGit, gitCommitAll, type GitRunner } from "@intentic/scaffold";

export interface AdoptRepo {
    // Local git repo to push, and the name it takes under the Forgejo admin owner.
    readonly dir: string;
    readonly name: string;
}

export interface AdoptOptions {
    // Transport authority for REST calls and the push; defaults to an SSH-forwarded loopback, no public DNS needed.
    readonly baseUrl: string;
    // Durable public authority written as each repo's `origin`; kept regardless of how this run's push traveled.
    readonly originBaseUrl: string;
    readonly user: string;
    readonly password: string;
    readonly repos: readonly AdoptRepo[];
    readonly log: (message: string) => void;
    readonly api?: ForgejoApi;
    readonly git?: GitRunner;
}

// Creates each repo under the admin owner if missing, commits pending changes, sets `origin` to the public url, and
// pushes `main` over the transport url. Credentials ride per-push via `http.extraHeader`, never `.git/config`.
export const adoptRepos = async (options: AdoptOptions): Promise<{ readonly name: string; readonly cloneUrl: string }[]> => {
    const api = options.api ?? forgejoApi;
    const git = options.git ?? defaultGit;
    const { baseUrl, originBaseUrl, user, password, repos, log } = options;
    const email = `${user}@${new URL(originBaseUrl).host}`;
    const authHeader = `AUTHORIZATION: basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
    // Repos are independent; adopted concurrently, but each stays sequential internally. Order mirrors `repos`.
    return Promise.all(
        repos.map(async ({ dir, name }) => {
            const existing = await api.findRepo({ baseUrl, user, password, owner: user, name });
            if (existing === undefined) {
                await api.createRepo({ baseUrl, user, password, owner: user, ownerIsOrg: false, name, private: true, autoInit: false });
                log(`created ${user}/${name} in Forgejo`);
            }
            await gitCommitAll(dir, "intentic adopt", { name: user, email }, git);
            const cloneUrl = `${originBaseUrl}/${user}/${name}.git`;
            const remotes = (await git(dir, ["remote"])).stdout.split("\n").map((line) => line.trim());
            await git(dir, remotes.includes("origin") ? ["remote", "set-url", "origin", cloneUrl] : ["remote", "add", "origin", cloneUrl]);
            // Pushes to the transport url, not `origin`: origin may not resolve yet (DNS/tunnel).
            await git(dir, ["-c", `http.extraHeader=${authHeader}`, "push", `${baseUrl}/${user}/${name}.git`, "main"]);
            log(`pushed ${dir} → ${cloneUrl}`);
            return { name, cloneUrl };
        }),
    );
};
