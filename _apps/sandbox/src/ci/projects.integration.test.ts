import { mkdtempSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { defaultGit } from "@intentic/scaffold";
import { expect, test } from "vitest";
import { fileCapabilitiesStore } from "../capabilities/capabilities-store.js";
import { ciProjects, parseRemote } from "./projects.js";

test("parseRemote covers the three remote forms git writes", () => {
    expect(parseRemote("https://github.com/acme/web.git")).toEqual({ host: "github.com", project: "acme/web" });
    expect(parseRemote("https://gitlab.example.com/group/sub/app")).toEqual({ host: "gitlab.example.com", project: "group/sub/app" });
    expect(parseRemote("git@github.com:acme/web.git")).toEqual({ host: "github.com", project: "acme/web" });
    expect(parseRemote("ssh://git@gitlab.example.com:2222/group/app.git")).toEqual({ host: "gitlab.example.com", project: "group/app" });
    expect(parseRemote("https://user@github.com/Acme/Web")).toEqual({ host: "github.com", project: "Acme/Web" });
});

test("parseRemote refuses what no CI stands behind", () => {
    expect(parseRemote("/home/user/repos/web")).toBeUndefined();
    expect(parseRemote("file:///home/user/repos/web")).toBeUndefined();
    expect(parseRemote("")).toBeUndefined();
});

const initRepo = async (dir: string, remote?: string): Promise<void> => {
    await mkdir(dir, { recursive: true });
    await defaultGit(dir, ["init", "--quiet"]);
    if (remote !== undefined) {
        await defaultGit(dir, ["remote", "add", "origin", remote]);
    }
};

test("ciProjects maps workspace repos onto connected accounts by remote hostname", async () => {
    const root = mkdtempSync(join(tmpdir(), "ci-projects-"));
    const capabilities = fileCapabilitiesStore(join(root, ".intentic", "capabilities.json"));
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

test('ciProjects includes the workspace root repo itself as "root"', async () => {
    const root = mkdtempSync(join(tmpdir(), "ci-root-"));
    const capabilities = fileCapabilitiesStore(join(root, ".intentic", "capabilities.json"));
    await capabilities.upsert({ id: "github", kind: "cli", config: { provider: "github", token: "t" } });
    await initRepo(root, "https://github.com/acme/mono.git");

    const projects = await ciProjects({ workspace: { root }, capabilities });
    expect(projects).toHaveLength(1);
    expect(projects[0]).toMatchObject({ repo: "root", project: "acme/mono" });
});

test("ciProjects is empty with no git accounts connected — no git spawns for nothing", async () => {
    const root = mkdtempSync(join(tmpdir(), "ci-none-"));
    await initRepo(join(root, "web"), "https://github.com/acme/web.git");
    const capabilities = fileCapabilitiesStore(join(root, ".intentic", "capabilities.json"));
    expect(await ciProjects({ workspace: { root }, capabilities })).toEqual([]);
});
