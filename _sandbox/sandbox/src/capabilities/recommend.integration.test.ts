import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Capability } from "@intentic/sandbox-contract";
import type { GitRunner } from "@intentic/scaffold";
import { expect, test } from "vitest";
import { capabilityRecommendations } from "./recommend.js";

// Pins that evidence is found where repos actually sit, the right card is picked, a connected capability suppresses it,
// and a decline holds only while the same evidence stands.

const workspace = async (files: Readonly<Record<string, string>>): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), "recommend-"));
    for (const [file, content] of Object.entries(files)) {
        const path = join(root, file);
        await mkdir(join(path, ".."), { recursive: true });
        await writeFile(path, content);
    }
    return root;
};

// Answers `git remote -v` from a table keyed by the dir's basename; an unlisted dir returns empty, like git itself.
const gitWithRemotes =
    (remotes: Readonly<Record<string, readonly string[]>>): GitRunner =>
    async (dir) => {
        const urls = remotes[dir.split("/").pop() ?? ""] ?? [];
        return { stdout: urls.map((url) => `origin\t${url} (fetch)\norigin\t${url} (push)`).join("\n"), stderr: "" };
    };
// No repo has a remote; the scan runs but finds nothing to map.
const noRemotes = gitWithRemotes({});

const docker: Capability = { id: "docker", kind: "docker", config: { gpu: "off" } };
const github: Capability = { id: "github", kind: "cli", config: { provider: "github", token: "t" } };

test("a compose file at a repo's root recommends docker, carrying the path as evidence", async () => {
    const root = await workspace({ "intentic/docker-compose.yml": "", "intentic/package.json": "" });
    expect(await capabilityRecommendations(root, [], [], noRemotes)).toEqual([
        { card: "docker", evidence: "intentic/docker-compose.yml", reason: "your workspace has a compose stack to run", prefill: {} },
    ]);
});

test("a compose file loose at the workspace root counts too", async () => {
    const root = await workspace({ "compose.yaml": "" });
    expect((await capabilityRecommendations(root, [], [], noRemotes)).map((entry) => entry.evidence)).toEqual(["compose.yaml"]);
});

test("nothing is recommended once the docker capability is active: the rebuild it asks for already happened", async () => {
    const root = await workspace({ "intentic/docker-compose.yml": "" });
    expect(await capabilityRecommendations(root, [docker], [], noRemotes)).toEqual([]);
});

test("a workspace with no compose file and no remotes recommends nothing", async () => {
    const root = await workspace({ "intentic/package.json": "", "notes.md": "" });
    expect(await capabilityRecommendations(root, [], [], noRemotes)).toEqual([]);
});

test("a dependency's compose file is not the user's stack, node_modules and dot-dirs are skipped", async () => {
    const root = await workspace({ "intentic/node_modules/some-pkg/docker-compose.yml": "", ".cache/compose.yml": "" });
    expect(await capabilityRecommendations(root, [], [], noRemotes)).toEqual([]);
});

test("the reference shelf is skipped while a repository-local refs directory remains ordinary", async () => {
    const root = await workspace({ "refs/upstream/docker-compose.yml": "", "app/refs/docker-compose.yml": "" });
    expect(await capabilityRecommendations(root, [], [], noRemotes)).toEqual([
        { card: "docker", evidence: "app/refs/docker-compose.yml", reason: "your workspace has a compose stack to run", prefill: {} },
    ]);
});

// Depth 2 is the cutoff: deeper belongs to a subproject's own tooling and would force a full-tree walk.
test("a compose file deeper than a repo's root is left alone", async () => {
    const root = await workspace({ "intentic/_tools/selfhost/docker-compose.yml": "" });
    expect(await capabilityRecommendations(root, [], [], noRemotes)).toEqual([]);
});

test("a repo whose remote is on github.com recommends the github card, naming the repo and the project", async () => {
    const root = await workspace({ "api/.git": "gitdir: elsewhere" });
    const git = gitWithRemotes({ api: ["git@github.com:acme/api.git"] });
    expect(await capabilityRecommendations(root, [], [], git)).toEqual([
        { card: "github", evidence: "api → github.com/acme/api", reason: "your repositories are hosted on GitHub", prefill: {} },
    ]);
});

test("a gitlab.com remote recommends gitlab, pre-filling the instance the card would otherwise ask for", async () => {
    const root = await workspace({ "api/.git": "gitdir: elsewhere" });
    const git = gitWithRemotes({ api: ["https://gitlab.com/team/api.git"] });
    expect(await capabilityRecommendations(root, [], [], git)).toEqual([
        {
            card: "gitlab",
            evidence: "api → gitlab.com/team/api",
            reason: "your repositories are hosted on GitLab",
            prefill: { url: "https://gitlab.com" },
        },
    ]);
});

// git.acme.dev only reads as GitLab because a .gitlab-ci.yml sits beside the remote pointing at it.
test("a pipeline file identifies a self-hosted GitLab whose hostname says nothing, and fills in its url", async () => {
    const root = await workspace({ "api/.git": "gitdir: elsewhere", "api/.gitlab-ci.yml": "stages: [build]" });
    const git = gitWithRemotes({ api: ["git@git.acme.dev:team/api.git"] });
    expect(await capabilityRecommendations(root, [], [], git)).toEqual([
        {
            card: "gitlab",
            evidence: "api/.gitlab-ci.yml → git.acme.dev",
            reason: "your repositories are hosted on your own GitLab",
            prefill: { url: "https://git.acme.dev" },
        },
    ]);
});

test("a connected github account stops the github recommendation without touching the others", async () => {
    const root = await workspace({ "api/.git": "gitdir: elsewhere", "api/docker-compose.yml": "" });
    const git = gitWithRemotes({ api: ["git@github.com:acme/api.git"] });
    expect((await capabilityRecommendations(root, [github], [], git)).map((entry) => entry.card)).toEqual(["docker"]);
});

test("a komodo resource file recommends komodo", async () => {
    const root = await workspace({ "deploy/komodo.toml": "[[stack]]\n" });
    expect(await capabilityRecommendations(root, [], [], noRemotes)).toEqual([
        { card: "komodo", evidence: "deploy/komodo.toml", reason: "your workspace drives a Komodo core", prefill: {} },
    ]);
});

test("a compose stack that runs Komodo recommends both komodo and docker, connectors before the rebuild", async () => {
    const root = await workspace({ "ops/compose.yml": "services:\n  core:\n    image: ghcr.io/moghtech/komodo-core:latest\n" });
    expect((await capabilityRecommendations(root, [], [], noRemotes)).map((entry) => entry.card)).toEqual(["komodo", "docker"]);
});

test("a compose stack of something else says nothing about komodo", async () => {
    const root = await workspace({ "ops/compose.yml": "services:\n  db:\n    image: postgres:16\n" });
    expect((await capabilityRecommendations(root, [], [], noRemotes)).map((entry) => entry.card)).toEqual(["docker"]);
});

test("a declined recommendation stays quiet", async () => {
    const root = await workspace({ "intentic/docker-compose.yml": "" });
    const dismissed = [{ card: "docker", evidence: "intentic/docker-compose.yml" }];
    expect(await capabilityRecommendations(root, [], dismissed, noRemotes)).toEqual([]);
});

test("a declined recommendation comes back when the evidence behind it changes", async () => {
    const root = await workspace({ "intentic/docker-compose.yml": "" });
    const dismissed = [{ card: "docker", evidence: "old/compose.yml" }];
    expect((await capabilityRecommendations(root, [], dismissed, noRemotes)).map((entry) => entry.card)).toEqual(["docker"]);
});

// The memo bounds the workspace scan to a TTL; the owner's own connect/decline actions bypass the clock entirely, since
// both ride the key rather than time.

// Counts git invocations, since the scan reaches git once per repo.
const countingRemotes = (urls: readonly string[]): { git: GitRunner; scans: () => number } => {
    let calls = 0;
    return {
        git: async () => {
            calls += 1;
            return { stdout: urls.map((url) => `origin\t${url} (fetch)`).join("\n"), stderr: "" };
        },
        scans: () => calls,
    };
};

test("a repeat read with the same inputs does not walk the workspace again", async () => {
    const root = await workspace({ "api/.git": "gitdir: elsewhere" });
    const { git, scans } = countingRemotes(["git@github.com:acme/api.git"]);
    const first = await capabilityRecommendations(root, [], [], git);
    expect(first.map((entry) => entry.card)).toEqual(["github"]);
    expect(await capabilityRecommendations(root, [], [], git)).toEqual(first);
    expect(await capabilityRecommendations(root, [], [], git)).toEqual(first);
    expect(scans()).toBe(1);
});

// `active` reaches the memo key through `wanted`, so connecting a card changes the key immediately.
test("connecting a card is never served from the memo", async () => {
    const root = await workspace({ "api/.git": "gitdir: elsewhere" });
    const { git } = countingRemotes(["git@github.com:acme/api.git"]);
    expect((await capabilityRecommendations(root, [], [], git)).map((entry) => entry.card)).toEqual(["github"]);
    expect(await capabilityRecommendations(root, [github], [], git)).toEqual([]);
});

test("declining a recommendation is never served from the memo", async () => {
    const root = await workspace({ "intentic/docker-compose.yml": "" });
    expect((await capabilityRecommendations(root, [], [], noRemotes)).map((entry) => entry.card)).toEqual(["docker"]);
    const dismissed = [{ card: "docker", evidence: "intentic/docker-compose.yml" }];
    expect(await capabilityRecommendations(root, [], dismissed, noRemotes)).toEqual([]);
});

// The workspace root is part of the memo key, so one sandbox's scan is never served to another.
test("a different workspace root is a different answer", async () => {
    const withCompose = await workspace({ "intentic/docker-compose.yml": "" });
    const without = await workspace({ "intentic/README.md": "" });
    expect((await capabilityRecommendations(withCompose, [], [], noRemotes)).map((entry) => entry.card)).toEqual(["docker"]);
    expect(await capabilityRecommendations(without, [], [], noRemotes)).toEqual([]);
});
