import type { ForgejoApi } from "@intentic/providers";
import { forgejoApi } from "@intentic/providers";
import { defaultGit, gitCommitAll, type GitRunner } from "@intentic/scaffold";

export interface AdoptRepo {
    // The local git repo to push and the name it takes under the Forgejo admin owner.
    readonly dir: string;
    readonly name: string;
}

export interface AdoptOptions {
    // The Forgejo public base url (https://git.<zone>) — both the REST authority and the clone-url host.
    readonly baseUrl: string;
    readonly user: string;
    readonly password: string;
    readonly repos: readonly AdoptRepo[];
    readonly log: (message: string) => void;
    readonly api?: ForgejoApi;
    readonly git?: GitRunner;
}

// Connect the local control-plane repos to remote Forgejo: create each repo under the admin owner if missing,
// auto-commit any pending local changes, wire a clean `origin`, and push `main`. Credentials are passed only
// per-push via `http.extraHeader` so they never land in `.git/config`. Returns the clone url of each repo.
export const adoptRepos = async (options: AdoptOptions): Promise<{ readonly name: string; readonly cloneUrl: string }[]> => {
    const api = options.api ?? forgejoApi;
    const git = options.git ?? defaultGit;
    const { baseUrl, user, password, repos, log } = options;
    const email = `${user}@${new URL(baseUrl).host}`;
    const authHeader = `AUTHORIZATION: basic ${Buffer.from(`${user}:${password}`).toString("base64")}`;
    const pushed: { name: string; cloneUrl: string }[] = [];
    for (const { dir, name } of repos) {
        const existing = await api.findRepo({ baseUrl, user, password, owner: user, name });
        if (existing === undefined) {
            await api.createRepo({ baseUrl, user, password, owner: user, ownerIsOrg: false, name, private: true, autoInit: false });
            log(`created ${user}/${name} in Forgejo`);
        }
        await gitCommitAll(dir, "intentic adopt", { name: user, email }, git);
        const cloneUrl = `${baseUrl}/${user}/${name}.git`;
        const remotes = (await git(dir, ["remote"])).stdout.split("\n").map((line) => line.trim());
        await git(dir, remotes.includes("origin") ? ["remote", "set-url", "origin", cloneUrl] : ["remote", "add", "origin", cloneUrl]);
        await git(dir, ["-c", `http.extraHeader=${authHeader}`, "push", "-u", "origin", "main"]);
        log(`pushed ${dir} → ${cloneUrl}`);
        pushed.push({ name, cloneUrl });
    }
    return pushed;
};
