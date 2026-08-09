import { mkdtempSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { STATE_DIR } from "@intentic/constants";
import { defaultGit } from "@intentic/scaffold";
import { expect, test } from "vitest";
import { fileCapabilitiesStore } from "../capabilities/capabilities-store.js";
import { ciProjects } from "./projects.js";

const initRepo = async (dir: string, remote?: string): Promise<void> => {
    await mkdir(dir, { recursive: true });
    await defaultGit(dir, ["init", "--quiet"]);
    if (remote !== undefined) {
        await defaultGit(dir, ["remote", "add", "origin", remote]);
    }
};

test("ciProjects maps workspace repos onto connected accounts by remote hostname", async () => {
    const root = mkdtempSync(join(tmpdir(), "ci-projects-"));
    const capabilities = fileCapabilitiesStore(join(root, `${STATE_DIR}`, "capabilities.json"));
    await capabilities.upsert({ id: "github", kind: "cli", config: { provider: "github", token: "t1" } });
    await capabilities.upsert({ id: "gitlab", kind: "cli", config: { provider: "gitlab", url: "https://gitlab.example.com", token: "t2" } });
    await initRepo(join(root, "web"), "https://github.com/acme/web.git");
    await initRepo(join(root, "app"), "git@gitlab.example.com:group/app.git");
    // A repo on a host nobody connected, and one with no remote at all — both ordinary, both skipped.
    await initRepo(join(root, "elsewhere"), "https://codeberg.org/acme/other.git");
    await initRepo(join(root, "local"));

    const projects = await ciProjects({ workspace: { root }, capabilities });
    expect(projects.map((project) => [project.repo, project.account.provider, project.project])).toEqual([
        ["app", "gitlab", "group/app"],
        ["web", "github", "acme/web"],
    ]);
    expect(projects.find((project) => project.repo === "app")?.account.apiBase).toBe("https://gitlab.example.com/api/v4");
});

// The shape a gitlab → github move leaves behind: the abandoned remote is still configured, and `git remote`
// sorts it AHEAD of origin, so reading only the first one mapped the repo to the host it moved off — then
// dropped it entirely once the gitlab account was disconnected.
test("ciProjects maps a repo by whichever of its remotes is connected, not the one git lists first", async () => {
    const root = mkdtempSync(join(tmpdir(), "ci-abandoned-"));
    const capabilities = fileCapabilitiesStore(join(root, `${STATE_DIR}`, "capabilities.json"));
    await capabilities.upsert({ id: "github", kind: "cli", config: { provider: "github", token: "t" } });
    const dir = join(root, "web");
    await initRepo(dir, "https://github.com/acme/web.git");
    await defaultGit(dir, ["remote", "add", "gitlab", "git@gitlab.com:acme/web.git"]);

    const projects = await ciProjects({ workspace: { root }, capabilities });
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({ repo: "web", project: "acme/web", account: { provider: "github" } });
});

// With BOTH hosts connected the repo still maps to exactly one project, and `origin` is what breaks the tie —
// the board must not flip hosts on a name that happens to sort first.
test("ciProjects breaks a multi-remote tie on origin", async () => {
    const root = mkdtempSync(join(tmpdir(), "ci-tie-"));
    const capabilities = fileCapabilitiesStore(join(root, `${STATE_DIR}`, "capabilities.json"));
    await capabilities.upsert({ id: "github", kind: "cli", config: { provider: "github", token: "t1" } });
    await capabilities.upsert({ id: "gitlab", kind: "cli", config: { provider: "gitlab", url: "https://gitlab.com", token: "t2" } });
    const dir = join(root, "web");
    await initRepo(dir, "https://github.com/acme/web.git");
    await defaultGit(dir, ["remote", "add", "gitlab", "git@gitlab.com:acme/web.git"]);

    const projects = await ciProjects({ workspace: { root }, capabilities });
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({ repo: "web", project: "acme/web", account: { provider: "github" } });
});

// A pushurl adds a second (push) line for the same remote; the (fetch) url is the one CI addresses.
test("ciProjects reads the fetch url of a remote that pushes somewhere else too", async () => {
    const root = mkdtempSync(join(tmpdir(), "ci-pushurl-"));
    const capabilities = fileCapabilitiesStore(join(root, `${STATE_DIR}`, "capabilities.json"));
    await capabilities.upsert({ id: "github", kind: "cli", config: { provider: "github", token: "t" } });
    const dir = join(root, "web");
    await initRepo(dir, "https://github.com/acme/web.git");
    await defaultGit(dir, ["remote", "set-url", "--add", "--push", "origin", "git@gitlab.com:acme/web.git"]);

    const projects = await ciProjects({ workspace: { root }, capabilities });
    expect(projects[0]).toMatchObject({ repo: "web", project: "acme/web", account: { provider: "github" } });
});

test('ciProjects includes the workspace root repo itself as "root"', async () => {
    const root = mkdtempSync(join(tmpdir(), "ci-root-"));
    const capabilities = fileCapabilitiesStore(join(root, `${STATE_DIR}`, "capabilities.json"));
    await capabilities.upsert({ id: "github", kind: "cli", config: { provider: "github", token: "t" } });
    await initRepo(root, "https://github.com/acme/mono.git");

    const projects = await ciProjects({ workspace: { root }, capabilities });
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({ repo: "root", project: "acme/mono" });
});

test("ciProjects is empty with no git accounts connected — no git spawns for nothing", async () => {
    const root = mkdtempSync(join(tmpdir(), "ci-none-"));
    await initRepo(join(root, "web"), "https://github.com/acme/web.git");
    const capabilities = fileCapabilitiesStore(join(root, `${STATE_DIR}`, "capabilities.json"));
    expect(await ciProjects({ workspace: { root }, capabilities })).toEqual([]);
});
