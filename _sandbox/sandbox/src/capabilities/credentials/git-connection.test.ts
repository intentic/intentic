import { VAULTED } from "@intentic/sandbox-contract/policy/capability-secrets";
import type { Capability } from "@intentic/sandbox-contract/schemas/capabilities";
import { GitConnectionError, gitReaderFor } from "./git-connection.js";

// A plugin or extension from a private repository reads it with the token typed on its own card, else with the token of
// the GitHub or GitLab card connected for that host: the one the install named, or the first by id.

const github = (id: string, token: string, git = "on"): Capability => ({ id, kind: "cli", config: { provider: "github", token, git } });
const store = (...cards: Capability[]) => {
    let reads = 0;
    return {
        list: async (): Promise<readonly Capability[]> => {
            reads += 1;
            return cards;
        },
        reads: () => reads,
    };
};

const REPO = "https://github.com/owner/private-plugin";

test("a token typed for the install wins, and no card is even read", async () => {
    const cards = store(github("github", "ghp_card"));
    await expect(gitReaderFor(cards, { url: REPO, token: "ghp_typed", gitConnection: "github" })).resolves.toEqual({ token: "ghp_typed" });
    expect(cards.reads()).toBe(0);
});

test("without one, the first card for the host by id lends its token, and is named", async () => {
    const cards = store(github("github-zed", "ghp_zed"), github("github-ada", "ghp_ada"));
    await expect(gitReaderFor(cards, { url: REPO })).resolves.toEqual({
        token: "ghp_ada",
        connection: { id: "github-ada", provider: "github", host: "github.com" },
    });
    // The one the install chose, not the first.
    await expect(gitReaderFor(cards, { url: REPO, gitConnection: "github-zed" })).resolves.toMatchObject({ token: "ghp_zed" });
});

test("a repository on a host no card answers for is read with nothing, as before", async () => {
    await expect(gitReaderFor(store(github("github", "ghp_card")), { url: "https://gitlab.com/owner/plugin" })).resolves.toEqual({});
    // A local path is never a host a token answers for, and the store is not read for it.
    const cards = store(github("github", "ghp_card"));
    await expect(gitReaderFor(cards, { url: "/srv/repos/plugin" })).resolves.toEqual({});
    expect(cards.reads()).toBe(0);
});

test("a named card that is gone, has git access off, or holds no token refuses rather than reading anonymously", async () => {
    await expect(gitReaderFor(store(github("github", "ghp_card")), { url: REPO, gitConnection: "github-old" })).rejects.toThrow(GitConnectionError);
    await expect(gitReaderFor(store(github("github", "ghp_card", "off")), { url: REPO, gitConnection: "github" })).rejects.toThrow(
        /"github" this was set to read https:\/\/github.com\/owner\/private-plugin with is gone/,
    );
    await expect(gitReaderFor(store(github("github", VAULTED)), { url: REPO })).rejects.toThrow(
        `your GitHub connection "github" holds no token to read ${REPO} with: connect it again, or paste an access token under Advanced.`,
    );
});
