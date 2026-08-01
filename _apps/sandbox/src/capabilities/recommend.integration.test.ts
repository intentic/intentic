import { mkdir, mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Capability } from "@intentic/sandbox-contract";
import { expect, test } from "vitest";
import { capabilityRecommendations } from "./recommend.js";

// The recommendation exists to make one specific failure legible: a compose-backed dev database in the workspace
// against a sandbox whose Docker Engine is dormant. So the cases that matter are "is the evidence found where
// repos actually sit" and "does it stay quiet once the capability is on".

const workspace = async (files: readonly string[]): Promise<string> => {
    const root = await mkdtemp(join(tmpdir(), "recommend-"));
    for (const file of files) {
        const path = join(root, file);
        await mkdir(join(path, ".."), { recursive: true });
        await writeFile(path, "");
    }
    return root;
};

const docker: Capability = { id: "docker", kind: "docker", config: {} };

test("a compose file at a repo's root recommends docker, carrying the path as evidence", async () => {
    const root = await workspace(["intentic/docker-compose.yml", "intentic/package.json"]);
    expect(await capabilityRecommendations(root, [])).toEqual([{ kind: "docker", evidence: "intentic/docker-compose.yml" }]);
});

test("a compose file loose at the workspace root counts too", async () => {
    const root = await workspace(["compose.yaml"]);
    expect(await capabilityRecommendations(root, [])).toEqual([{ kind: "docker", evidence: "compose.yaml" }]);
});

test("nothing is recommended once the docker capability is active — the rebuild it asks for already happened", async () => {
    const root = await workspace(["intentic/docker-compose.yml"]);
    expect(await capabilityRecommendations(root, [docker])).toEqual([]);
});

test("a workspace with no compose file recommends nothing", async () => {
    const root = await workspace(["intentic/package.json", "notes.md"]);
    expect(await capabilityRecommendations(root, [])).toEqual([]);
});

test("a dependency's compose file is not the user's stack — node_modules and dot-dirs are skipped", async () => {
    const root = await workspace(["intentic/node_modules/some-pkg/docker-compose.yml", ".cache/compose.yml"]);
    expect(await capabilityRecommendations(root, [])).toEqual([]);
});

// Depth 2 is the cutoff: a compose file three levels down belongs to a subproject's own tooling, and scanning
// for it would turn every /capabilities load into a full-tree walk.
test("a compose file deeper than a repo's root is left alone", async () => {
    const root = await workspace(["intentic/_tools/selfhost/docker-compose.yml"]);
    expect(await capabilityRecommendations(root, [])).toEqual([]);
});
