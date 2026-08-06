import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Capability } from "@intentic/sandbox-contract";
import type { GitRunner } from "@intentic/scaffold";
import { expect, test } from "vitest";
import { capabilityRecommendations } from "./recommend.js";

/* The scan exists to make specific failures legible — a compose-backed dev database against a dormant Docker
 * Engine, a workspace of GitHub repos against an agent that cannot read one issue. So what these cases hold is
 * that the evidence is found where repos actually sit, that it identifies the right card, that a connected
 * capability stops it, and that a declined one stays declined only while it is answering the same claim. */

const workspace = async (files: Readonly<Record<string, string>>): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), "recommend-"));
    for (const [file, content] of Object.entries(files)) {
        const path = join(root, file);
        await mkdir(join(path, ".."), { recursive: true });
        await writeFile(path, content);
    }
    return root;
};

// `git remote -v` per repo dir, answered from a table keyed by the dir's basename. A dir with no entry answers
// like a repo with no remote configured (empty output), which is what git itself does.
const gitWithRemotes =
    (remotes: Readonly<Record<string, readonly string[]>>): GitRunner =>
    async (dir) => {
        const urls = remotes[dir.split("/").pop() ?? ""] ?? [];
        return { stdout: urls.map((url) => `origin\t${url} (fetch)\norigin\t${url} (push)`).join("\n"), stderr: "" };
    };
// No repo has a remote — the scan still runs, it just finds nothing to map.
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

test("nothing is recommended once the docker capability is active — the rebuild it asks for already happened", async () => {
    const root = await workspace({ "intentic/docker-compose.yml": "" });
    expect(await capabilityRecommendations(root, [docker], [], noRemotes)).toEqual([]);
});

test("a workspace with no compose file and no remotes recommends nothing", async () => {
    const root = await workspace({ "intentic/package.json": "", "notes.md": "" });
    expect(await capabilityRecommendations(root, [], [], noRemotes)).toEqual([]);
});

test("a dependency's compose file is not the user's stack — node_modules and dot-dirs are skipped", async () => {
    const root = await workspace({ "intentic/node_modules/some-pkg/docker-compose.yml": "", ".cache/compose.yml": "" });
    expect(await capabilityRecommendations(root, [], [], noRemotes)).toEqual([]);
});

// Depth 2 is the cutoff: a compose file three levels down belongs to a subproject's own tooling, and scanning
// for it would turn every /capabilities load into a full-tree walk.
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

// The case a hostname cannot answer on its own, and the reason the pipeline file is read at all: `git.acme.dev`
// is a GitLab only because a .gitlab-ci.yml sits next to the remote pointing at it.
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

// The whole point of keying a dismissal on the evidence: "no, not for that" is not "no, never".
test("a declined recommendation comes back when the evidence behind it changes", async () => {
    const root = await workspace({ "intentic/docker-compose.yml": "" });
    const dismissed = [{ card: "docker", evidence: "old/compose.yml" }];
    expect((await capabilityRecommendations(root, [], dismissed, noRemotes)).map((entry) => entry.card)).toEqual(["docker"]);
});
