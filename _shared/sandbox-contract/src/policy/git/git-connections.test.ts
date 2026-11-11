import { type GitConnectionCandidate, gitConnectionsFor, gitUrlHost } from "./git-connections.js";

const github = (id: string, git = "on"): GitConnectionCandidate => ({ id, kind: "cli", config: { provider: "github", git, hasSecret: true } });
const gitlab = (id: string, url: string): GitConnectionCandidate => ({ id, kind: "cli", config: { provider: "gitlab", url, git: "on" } });

describe("which connection reads a repository", () => {
    it("matches GitHub cards to github.com and orders them by id, whatever order they were listed in", () => {
        const found = gitConnectionsFor([github("github-zed"), github("github-ada"), gitlab("gitlab", "https://gitlab.com")], "https://github.com/o/r");
        expect(found).toEqual([
            { id: "github-ada", provider: "github", host: "github.com" },
            { id: "github-zed", provider: "github", host: "github.com" },
        ]);
    });

    it("matches a GitLab card to its own instance's host, port included", () => {
        const cards = [gitlab("gitlab", "https://gitlab.com"), gitlab("work", "https://git.example.test:8443/")];
        expect(gitConnectionsFor(cards, "https://git.example.test:8443/team/plugin.git")).toEqual([
            { id: "work", provider: "gitlab", host: "git.example.test:8443" },
        ]);
        expect(gitConnectionsFor(cards, "https://git.example.test/team/plugin.git")).toEqual([]);
    });

    it("skips a card whose git access is off, a card of another provider, and any other kind", () => {
        const cards: GitConnectionCandidate[] = [
            github("github", "off"),
            { id: "slack", kind: "cli", config: { provider: "slack" } },
            { id: "custom", kind: "mcp", config: { url: "https://github.com/mcp" } },
        ];
        expect(gitConnectionsFor(cards, "https://github.com/o/r")).toEqual([]);
    });

    it("never lends a token over plain http, except to a GitLab instance the card itself names at http", () => {
        const cards = [github("github"), gitlab("secure", "https://git.example.test"), gitlab("lan", "http://git.lan.test")];
        expect(gitConnectionsFor(cards, "http://github.com/o/r")).toEqual([]);
        expect(gitConnectionsFor(cards, "http://git.example.test/team/plugin.git")).toEqual([]);
        expect(gitConnectionsFor(cards, "http://git.lan.test/team/plugin.git")).toEqual([{ id: "lan", provider: "gitlab", host: "git.lan.test" }]);
        expect(gitConnectionsFor(cards, "https://git.lan.test/team/plugin.git")).toEqual([{ id: "lan", provider: "gitlab", host: "git.lan.test" }]);
    });

    it("reads only http(s) addresses: an ssh remote or a path has no host a token answers for", () => {
        expect(gitUrlHost("git@github.com:o/r.git")).toBeUndefined();
        expect(gitUrlHost("/srv/repos/plugin")).toBeUndefined();
        expect(gitUrlHost(" HTTPS://GitHub.com/o/r ")).toBe("github.com");
        expect(gitConnectionsFor([github("github")], "ssh://git@github.com/o/r.git")).toEqual([]);
    });
});
