import type { ForgejoApi } from "@intentic/providers";
import { forgejoApi } from "@intentic/providers";
import { defaultGit, gitCommitAll, type GitRunner } from "@intentic/scaffold";

export interface AdoptRepo {
    // The local git repo to push and the name it takes under the Forgejo admin owner.
    readonly dir: string;
    readonly name: string;
}

export interface AdoptOptions {
    // The TRANSPORT authority for the REST calls and the push, by default an SSH-forwarded loopback url to
    // Forgejo on the host, so adopt never depends on the public route (or on DNS existing at all).
    readonly baseUrl: string;
    // The durable public authority (https://git.<zone>) written as each repo's `origin`, the identity the
    // repos keep after adopt, independent of how this run's push traveled.
    readonly originBaseUrl: string;
    readonly user: string;
    readonly password: string;
    readonly repos: readonly AdoptRepo[];
    readonly log: (message: string) => void;
    readonly api?: ForgejoApi;
    readonly git?: GitRunner;
}

// Connect the local control-plane repos to remote Forgejo: create each repo under the admin owner if missing,
// auto-commit any pending local changes, wire a clean `origin` (public url), and push `main` over the
// transport url. Credentials are passed only per-push via `http.extraHeader` so they never land in
// `.git/config`. Returns the public clone url of each repo.
export const adoptRepos = async (options: AdoptOptions): Promise<{ readonly name: string; readonly cloneUrl: string }[]> => {
    const api = options.api ?? forgejoApi;
    const git = options.git ?? defaultGit;
    const { baseUrl, originBaseUrl, user, password, repos, log } = options;
    const email = `${user}@${new URL(originBaseUrl).host}`;
    const authHeader = `AUTHORIZATION: basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
    // Each repo is independent (own dir, own Forgejo repo), adopt them concurrently; the per-repo step
    // ordering stays sequential inside each map entry. Result order mirrors `repos`.
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
            // Push straight to the transport url, not `origin`, origin may not resolve yet (DNS/tunnel).
            await git(dir, ["-c", `http.extraHeader=${authHeader}`, "push", `${baseUrl}/${user}/${name}.git`, "main"]);
            log(`pushed ${dir} → ${cloneUrl}`);
            return { name, cloneUrl };
        }),
    );
};
